const uuidv4 = require('uuid/v4')

exports = module.exports = {}

exports.trades = {}
exports.figures = {
  unrealized_buys: 0,
  pending_buys: 0,
  pending_sells: 0,
  profit: 0,
  net_gain: 0,
  current_cash: 0,
  max_profit: 0
}

const crunch_figures = () => {
  let pending_buy_trades = _.filter( _.values(exports.trades), (t) => {
    if( t.state === 'ping' || t.state === 'partialbuy' || t.buy.pending ) return true
    return false
  })
  exports.figures.pending_buys = _.reduce( pending_buy_trades, (sum, t) => {
    return sum += t.size*t.buy.executed_price
  }, 0 )
  let pending_sell_trades = _.filter( _.values(exports.trades), (t) => t.state === 'pong' )
  exports.figures.pending_sells = _.reduce( pending_sell_trades, (sum, t) => {
    return sum += t.size*t.sell.executed_price
  }, 0 )
  exports.figures.unrealized_buys = _.reduce( pending_sell_trades, (sum, t) => {
    return sum += t.size*t.buy.executed_price
  }, 0 )
  exports.figures.profit = account.account.sells-account.account.buys
  exports.figures.net_gain = exports.figures.profit-account.account.fees
  exports.figures.current_cash = settings.multipong.initial_cash+exports.figures.net_gain-exports.figures.pending_buys
  exports.figures.max_profit = exports.figures.net_gain+exports.figures.pending_sells
}

const reset = exports.reset = () => {
  exports.trades = {}
  exports.figures = {
    unrealized_buys: 0,
    pending_buys: 0,
    pending_sells: 0,
    profit: 0,
    net_gain: 0,
    current_cash: 0,
    max_profit: 0
  }
}

const load = exports.load = () => {
  reset()
  // Read all unsettled trades into memory
  let old_trades = db.collections.trades.find({
    settled: false
  })
  // All trades should be re-synced on load
  for( let trade of old_trades ) {
    exports.trades[trade.trade_id] = trade
  }
  for( let trade of _.values(exports.trades) ) {
    mark_trade_for_sync( exports.trades[trade.trade_id], true )
  }
}

const create_trade = exports.create_trade = (trade_size, buy_price, sell_price) => {
  let trade_id = uuidv4()
  let trade = {
    trade_id,
    size: trade_size,
    trade_width: (sell_price-buy_price),
    side: 'buy', // always start with a buy!
    active_order_id: null,
    buy: {
      order_id: null,
      pending: false,
      settled: false,
      price: buy_price,
      executed_price: null,
      fees: 0,
      next_attempt: new Date()
    },
    sell: {
      order_id: null,
      pending: false,
      settled: false,
      price: sell_price,
      executed_price: null,
      fees: 0,
      next_attempt: new Date()
    },
    settled: false,
    state: 'empty',
    sync_status: {
      syncing: false,
      needs_sync: false,
      retries: 0
    }
  }
  trade = db.collections.trades.insert(trade)
  exports.trades[trade_id] = trade
  return trade_id
}

const trade_fill = (trade, fill_data) => {
  //  Update trade to indicate buy or sell is complete
  switch( trade.side ) {
    case 'buy':
      ui.logger('sys_log', `Bought trade ${trade.trade_id} @ ${fill_data.price}`)
      update(trade, (t) => {
        t.buy.pending = false
        t.buy.settled = true
        t.buy.fees = fill_data.fees
        t.buy.fiat_value = fill_data.fiat_value
        t.state = 'full'
      })
      account.update( account.account, (a) => {
        a.buy_count++
        a.buys += fill_data.fiat_value
      })
      break
    case 'sell':
      ui.logger('sys_log', `Sold trade ${trade.trade_id} @ ${fill_data.price}`)
      update(trade, (t) => {
        t.sell.pending = false
        t.sell.settled = true
        t.sell.fees = fill_data.fees
        t.sell.fiat_value = fill_data.fiat_value
        t.state = 'complete'
      })
      account.update( account.account, (a) => {
        a.sell_count++
        a.sells += fill_data.fiat_value
      })
      break
  }
}

const trade_partial_fill = exports.trade_partial_fill = ( trade ) => {
  switch( trade.side ) {
    case 'buy':
      update(trade, (t) => {
        t.buy.pending = false
        t.buy.settled = false
        t.state = 'partialbuy'
      })
      break
    case 'sell':
      update(trade, (t) => {
        t.sell.pending = false
        t.sell.settled = false
        t.state = 'partialsell'
      })
      break
  }
}

const trade_open = ( trade ) => {
  switch( trade.side ) {
    case 'buy':
      //if(  )
      update(trade, (t) => {
        t.buy.pending = true
        t.buy.settled = false
        t.state = 'ping'
      })
      break
    case 'sell':
      update(trade, (t) => {
        t.sell.pending = true
        t.sell.settled = false
        t.state = 'pong'
      })
      break
  }
}

const trade_canceled = ( trade ) => {
  switch( trade.side ) {
    case 'buy':
      update(trade, (t) => {
        t.state = 'canceled'
        t.settled = true
        t.active_order_id = null
      })
      break
    case 'sell':
      reset_order( trade )
      break
  }
}

const mark_trade_for_sync = exports.mark_trade_for_sync = (trade, force=false) => {
  //if( !force && (trade.sync_status.syncing || trade.sync_status.needs_sync) ) return
  update(trade, (t) => {
    t.sync_status.syncing = false
    t.sync_status.needs_sync = true
    t.sync_status.retries = 0
    t.sync_status.next_sync = new Date( new Date().valueOf() + 5000 )
  })
}

const mark_trade_sync_complete = (trade) => {
  update( trade, (t) => {
    t.sync_status.needs_sync = false
    t.sync_status.syncing = false
  } )
}

exports.sync_trade = async function sync_trade( trade ) {
  if( trade.sync_status.syncing ) return
  update(trade, (t) => {
    t.sync_status.syncing = true
  })

  ui.logger('sys_log', `Syncing trade ${trade.trade_id}`)
  let order_id = trade.active_order_id
  // If there's nothing to sync...
  if( !order_id ) {
    reset_trade(trade)
    mark_trade_sync_complete( trade )
    return
  }
  ui.logger('sys_log', `Syncing order ${order_id}`)

  let data
  try {
    data = await gdax.get_order_by_id( order_id )
  } catch( e ) {
    ui.logger('gdax_log', JSON.stringify(e))
    //  TODO: analyze failure modes
  }

  if( !data ) return

  // Maybe this order was canceled, or we are checking too soon.
  let not_found = false
  if( data.message && data.message === 'NotFound' ) {
    ui.logger('sys_log', `Trade ${trade.trade_id} not found in GDAX.`)
    not_found = true
    if( trade.state === 'canceling' ) {
      reset_trade( trade )
      mark_trade_sync_complete( trade )
      return
    }
    update( trade, (t) => {
      t.sync_status.syncing = false
      t.sync_status.retries++
      t.sync_status.next_sync = new Date( new Date().valueOf() + 1000 )
    })
  }

  //  Don't retry forever
  if( trade.sync_status.retries > 5 ) {
    reset_trade( trade )
    mark_trade_sync_complete( trade )
    return
  }

  if( not_found ) return

  ui.logger('gdax_log', data)
  switch( data.status ) {
    case 'done':
      switch( data.done_reason ) {
        case 'filled':
          let fill_data = {
            created_at: new Date(data.done_at),
            //side: data.side,
            order_id: data.id,
            //trade_size: settings.multipong.trade_size,
            price: parseFloat( data.price ),
            fiat_value: trade.size * parseFloat(data.price),
            fees: parseFloat(data.fill_fees)
          }
          trade_fill( trade, fill_data )
          break
        case 'canceled':
          trade_canceled( trade )
          break
        }
        break
    case 'open':
      // partial or none?
      let filled_size = parseFloat(data.filled_size)
      if( filled_size ) {
        trade_partial_fill(trade)
      } else {
        trade_open(trade)
      }
      break
    default:
      break
  }
  mark_trade_sync_complete( trade )
}

const reset_trade = (trade) => {
  ui.logger('sys_log', `Resetting trade ${trade.trade_id}`)
  switch( trade.side ) {
    case 'buy':
      update( trade, (t) => {
        t.state = 'empty'
        t.buy.order_id = null
        t.buy.pending = false
        t.buy.settled = false
        t.active_order_id = null
      })
      break
    case 'sell':
      update( trade, (t) => {
        t.state = 'full'
        t.sell.order_id = null
        t.sell.pending = false
        t.sell.settled = false
        t.active_order_id = null
      } )
      break
  }
}

const handle_trade_error = ( trade, error ) => {
  /*
  update(trade, (t) => {
    t[t.side].order_id = null
    t
  })
  if( error === 'Too small' ) {
    update_bucket(bucket, (b) => {
      b.state = 'toosmall'
    })
    logger('sys_log', 'Disabling bucket due to order size being too small.')
    return true
  }
*/
  if( error === 'Insufficient funds' ) {
    update(trade, (t) => {
      t.state = 'insufficientfunds'
      t[t.side].next_attempt = new Date(new Date().valueOf() + 5000)
    })
    ui.logger('sys_log', `Insufficient funds to place ${trade.side} order for trade ${trade.trade_id}.`)
    return true
  }

  if( error == 'Unknown error' ) {
    return false
  }

  return false
}

const buy_trade = (trade) => {
  if( !trade_data.buys.enabled ) return
  if( !settings.multipong.greedy && trade.buy.price * trade.size > exports.figures.current_cash ) return
  update( trade, (t) => {
    t.buy.pending = true
    t.side = 'buy'
  })
  ui.logger('sys_log', `Buying trade ${trade.trade_id}`)
  gdax.limit_order( 'buy', settings.product_id, trade.buy.price, trade.size )
  .then( (data) => {
    update( trade, (t) => {
      t.buy.executed_price = parseFloat(data.price)
      t.buy.order_id = data.id
      t.active_order_id = data.id
      t.state = 'ping'
    } )
  })
  .catch( (error) => {
    ui.logger('gdax_log', error)
    if( handle_trade_error( trade, error ) ) return
    reset_trade(trade)
  })
}

const sell_trade = ( trade ) => {
  if( !trade_data.sells.enabled ) return
  //  Make sure sell price is competitive
  let sell_price = trade.sell.price
  if( trade.sell.price < gdax.midmarket_price.current ) {
    sell_price = gdax.midmarket_price.current + 1*settings.bucket_width
  }
  update(trade, (t) => {
    t.sell.pending = true
    t.side = 'sell'
  })
  ui.logger('sys_log', `Selling trade ${trade.trade_id}`)
  gdax.limit_order('sell', settings.product_id, sell_price, trade.size )
  .then( (data) => {
    update(trade, (t) => {
      t.sell.executed_price = parseFloat(data.price)
      t.sell.order_id = data.id
      t.active_order_id = data.id
      t.state = 'pong'
    })
  })
  .catch( (error) => {
    handle_trade_error( trade, error )
    reset_trade(trade)
    ui.logger('gdax_log', error)
  })
}

/**
 *  Trades can only be canceled if they are pending buys.
 *  Sells, partial sells, or partial buys cannot be canceled to preserve profit!
 */
const can_cancel = exports.can_cancel = (trade) => {
  if( trade.side === "buy" && trade.buy.pending === true && trade.state !== "canceling" && trade.state !== "cancel-pending" ) return true
  return false
}

const cancel_trade = exports.cancel_trade = (trade, cancel_buy=true, cancel_sell=false) => {
  ui.logger('sys_log', `Marking trade ${trade.trade_id} for cancelation`)
  update(trade, (t) => {
    t.state = 'cancel-pending'
    t.next_attempt = new Date( new Date().valueOf() + 2000 )
  })
}

const execute_trade_cancelation = (trade, cancel_buy=true, cancel_sell=false) => {
  update(trade, (t) => {
    t.state = 'canceling'
  })
  ui.logger('sys_log', `Canceling trade ${trade.trade_id}`)

  mark_trade_for_sync( trade )

  if( cancel_buy ) {
    if( trade.buy.order_id && trade.buy.pending === true ) {
      gdax.cancel_order( trade.buy.order_id )
    }
  }

  if( cancel_sell ) {
    if( trade.sell.order_id && trade.sell.pending === true ) {
      gdax.cancel_order( trade.sell.order_id )
    }
  }
}

const cancel_all_buys = exports.cancel_all_buys = () => {
  ui.logger('sys_log', 'Canceling all buys')
  _.forEach( _.filter(_.values(exports.trades), (t) => can_cancel(t)), (t) => {
    cancel_trade(t)
  })
}

const delete_trade = (trade) => {
  let trade_id = trade.trade_id
  delete exports.trades[trade_id]
  ui.logger('sys_log', `Deleting unused trade ${trade_id}`)
  let bucket = _.findWhere( buckets.buckets, {trade_id: trade_id} )
  if( bucket ) {
    buckets.update( bucket, (b) => {
      b.trade_id = null
    })
  }
  db.collections.trades.findAndRemove({trade_id: trade_id})
}

const apply_trade = ( trade ) => {
  //  Track profits and fees
  account.update( account.account, (a) => {
    a.fees += trade.sell.fees + trade.buy.fees
  })

  //  Settle the trade
  update(trade, (t) => {
    t.settled = true
    t.state = 'settled'
  })
}

const wait_for_all_trades_to_sync = exports.wait_for_all_trades_to_sync = () => {
  return new Promise(function(resolve, reject) {
    let timer
    function check_ready() {
      let unsynced_trades = _.filter( _.values(exports.trades), (t) => t.sync_status.needs_sync)
      if( unsynced_trades && unsynced_trades.length === 0 ) {
        clearInterval(timer)
        resolve()
      }
    }
    timer = setInterval( check_ready, 1000 )
  })
}

const process_trades = exports.process_trades = () => {
  for( let trade of _.sortBy(_.values(exports.trades), t => -t.buy.price) ) {
    if( trade.sync_status.needs_sync && new Date() > trade.sync_status.next_sync ) {
      exports.sync_trade( trade )
      .catch( (e) => {
        ui.logger('sys_log', e)
      })
      continue
    }
    switch( trade.state ) {
      case 'empty':
        let bucket = _.findWhere( buckets.buckets, {trade_id: trade.trade_id} )
        if( bucket && buckets.valid_buy_price(trade.buy.price) ) {
          if( !trade.buy.order_id && !trade.buy.pending /*&& (trade.buy.next_attempt === null || trade.buy.next_attempt < new Date())*/ ) {
            buy_trade( trade )
          }
        } else {
          if( !trade.buy.pending ) {
            //  Delete this trade!
            delete_trade( trade )
          }
        }
        break
      case 'ping':
        if( !buckets.valid_buy_price(trade.buy.price) ) {
          //  Delete this trade!
          cancel_trade( trade )
        }
        break
      case 'full':
        if( !trade.sell.order_id && !trade.sell.pending ) {
          sell_trade( trade )
        }
        break
      case 'complete':
        apply_trade( trade )
        break
      case 'settled':
        delete_trade( trade )
        break
      case 'cancel-pending':
        if( new Date() >= trade.next_attempt ) execute_trade_cancelation(trade)
        break
      case 'canceled':
        if( buckets.valid_buy_price(trade.buy.price) ) {
          reset_trade( trade )
        } else {
          delete_trade( trade )
        }
        break
      case 'insufficientfunds':
        if( new Date() > trade[trade.side].next_attempt ) {
          reset_trade(trade)
        }
        break
      default:
        break
    }
    crunch_figures()
  }
}

const update = (trade, mutator) => {
  mutator(trade)
  //ui.logger('sys_log', `update_trade: ${JSON.stringify(trade)}`)
  try {
    db.collections.trades.update( trade )
  } catch( e ) {
    ui.logger('sys_log', JSON.stringify(e))
  }
}
