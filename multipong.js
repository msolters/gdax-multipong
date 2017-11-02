fs = require("fs")
settings = JSON.parse( fs.readFileSync("settings.json", "utf8") )
const gdax = require('gdax')
const _ = require('underscore')
const moment = require('moment-timezone')
const gdax_private = new gdax.AuthenticatedClient(settings.gdax.api.key, settings.gdax.api.secret, settings.gdax.api.passphrase, settings.gdax.api.uri)
const blessed = require('blessed')
const contrib = require('blessed-contrib')
const loki = require('lokijs')
const collections = {}
let db

const bucket_width = (settings.multipong.max_price - settings.multipong.min_price)/settings.multipong.num_buckets
const cash_per_bucket = settings.multipong.initial_cash/settings.multipong.num_buckets
let db_trades, db_buckets
let midmarket_price = {
  current: null,
  velocity: 0.0
}
let orderbook_synced = false
let current_cash = settings.multipong.initial_cash
let fees = 0
let buy_count = 0
let sell_count = 0
settings.product_id = `${settings.multipong.coin}-${settings.multipong.fiat}`
const log_file = fs.createWriteStream(`${settings.product_id}.log`)

/**
 *  Database
 */
function init_db() {
  logger('sys_log', 'Initializing database')
  db = new loki(`${settings.product_id}.db`, {
  	autoload: true,
    autoupdate: true,
  	autoloadCallback: init_db_cb,
  	autosave: true,
  	autosaveInterval: 2000
  })
}

/**
 *  Ensure a collection exists in the DB and that a reference to it exists
 *  in the collections object.
 */
function db_set(collection) {
  collections[collection] = db.getCollection(collection)
  if( collections[collection] === null ) {
    collections[collection] = db.addCollection(collection)
  }
}

/**
 *  Configure the collections we will need and do initial data loading from
 *  disk.
 *  Then start the app!
 */
function init_db_cb() {
  db_set('trades')
  db_set('buckets')
  retrieve_completed_trades()
  start_app()
}

/**
 *  UI
 */
let screen
const ui = {}

const exit_gracefully = () => {
  logger('sys_log', 'Exiting...')
  db.close()
  log_file.end()
  return process.exit(0)
}

const init_screen = () => {
  if( settings.multipong.DEBUG ) return
  screen = blessed.screen()
  screen.key(['escape', 'q', 'C-c'], (ch, key) => {
    exit_gracefully()
  })
  ui.overview_table = contrib.table({
    top: '2%',
    left: '2%',
    width: '46%',
    height: '13%',
    label: 'Overview',
    border: {type: 'line', fg: 'yellow'},
    fg: 'yellow',
    interactive: false,
    columnSpacing: 4,               //in chars
    columnWidth: [14, 8, 12, 12, 8, 12, 12, 6],  // in chars
  })
  ui.bucket_table = contrib.table({
    keys: true,
    fg: 'yellow',
    interactive: false,
    label: 'Trade Buckets',
    width: '48%',
    height: '96%',
    top: '2%',
    left: '50%',
    border: {type: "line", fg: "yellow"},
    columnSpacing: 4, //in chars
    columnWidth: [4, 12, 12, 12, 4, 17], /*in chars*/
  })
  ui.trade_log = contrib.log({
    fg: "yellow",
    selectedFg: "yellow",
    label: 'Trade Log',
    left: '2%',
    top: '16%',
    width: '46%',
    height: '28%',
    border: {type: "line", fg: "yellow"}
  })
  ui.sys_log = contrib.log({
    fg: "yellow",
    selectedFg: "yellow",
    label: 'System Log',
    left: '2%',
    top: '47%',
    width: '46%',
    height: '51%',
    border: {type: "line", fg: "yellow"}
  })

  screen.append(ui.overview_table)
  screen.append(ui.bucket_table)
  screen.append(ui.trade_log)
  screen.append(ui.sys_log)
  setInterval( () => {
    refresh_overview_table()
    refresh_bucket_table()
    screen.render()
  }, 300 )
}

const refresh_bucket_table = () => {
  let table_data = []
  let non_empty_buckets = _.filter(buckets, (b) => b.state !== 'empty')
  for( let bucket of _.sortBy(non_empty_buckets, (b) => -b.buy_price) ) {
    let order_id = '-'
    if( bucket.order_id ) order_id = bucket.order_id
    let current_sell_price = '-'
    if( bucket.current_sell_price > 0 ) current_sell_price = `$${bucket.current_sell_price.toFixed(2)}`
    let row = [bucket.idx, `$${bucket.buy_price}`, `$${bucket.sell_price}`, current_sell_price, bucket.trade_size, bucket.state]
    table_data.push( row )
  }

  ui.bucket_table.setData({
    headers: ['#', 'Low', 'High', 'Sell @', 'Size', 'State'],
    data: table_data
  })
}

const refresh_overview_table = () => {
  let current_price = 'Loading'
  if( orderbook_synced ) current_price = `$${midmarket_price.current.toFixed(3)}`
  let pong_sum = _.reduce(_.where(buckets, {state: 'pong'}), (sum, bucket) => sum+(bucket.sell_price*bucket.trade_size), 0)
  let net_gain = current_cash-settings.multipong.initial_cash-fees
  ui.overview_table.setData({
    headers: [`P (${settings.product_id})`, 'dP/dt', 'Initial Cash', 'Cash on Hand', 'Fees', 'Net Gain', 'Max Gain', 'B/S'],
    data: [[current_price, `$${midmarket_price.velocity.toPrecision(4)}/s`, `$${settings.multipong.initial_cash.toFixed(2)}`, `$${current_cash.toFixed(2)}`, `$${fees.toFixed(2)}`, `$${net_gain.toPrecision(4)}`, `$${(net_gain + pong_sum).toPrecision(4)}`, `${buy_count}/${sell_count}`]]
  })
}

const logger = (target, content) => {
  if( typeof content !== 'string' ) {
    content = JSON.stringify(content)
  }
  log_file.write( content )
  log_file.write('\n')
  if( settings.multipong.DEBUG ) {
    console.log(content)
    return
  }
  ui[target].log(`${moment().tz(settings.tz).format('HH:mm:ss')} ${content}`)
}

/**
 *  Market Data
 */
const orderbook = new gdax.OrderbookSync([settings.product_id])

const set_midmarket_price = () => {
  let max_bid = orderbook.books[settings.product_id]._bids.max()
  let min_ask = orderbook.books[settings.product_id]._asks.min()
  if(!max_bid || !min_ask) {
    return null
  }
  if(!orderbook_synced) {
    orderbook_synced = true
  }
  max_bid = parseFloat(max_bid.price.toString())
  min_ask = parseFloat(min_ask.price.toString())
  let new_midmarket_price = (max_bid+min_ask)/2
  if( midmarket_price.current !== null ) {
    midmarket_price.velocity = new_midmarket_price - midmarket_price.current
    midmarket_price.velocity *= (1000/settings.multipong.midmarket_price_period)
  }
  midmarket_price.current = new_midmarket_price
}

const init_orderbook = () => {
  logger('sys_log', `Loading ${settings.product_id} order book`)
  setInterval( set_midmarket_price, settings.multipong.midmarket_price_period )
}

const wait_for_orderbook_sync = () => {
  setTimeout( () => {
    if( orderbook_synced ) {
      init_trading()
    } else {
      wait_for_orderbook_sync()
    }
  }, 1000)
}

/**
 *  Trading
 */
const gdax_ws = new gdax.WebsocketClient([settings.product_id], 'wss://ws-feed.gdax.com', {
    key: settings.gdax.api.key,
    secret: settings.gdax.api.secret,
    passphrase: settings.gdax.api.passphrase,
  }, {
    heartbeat: true,
    channels: ['user', 'heartbeat']
  })

const init_ws_stream = () => {
  gdax_ws.on('message', (data) => {
    if( data.type === "heartbeat" ) return
    switch( data.type ) {
      case "heartbeat":
      case "subscriptions":
       return
       break
      default:
        process_message(data)
        break
    }
  })
  gdax_ws.on('error', (error) => {
    logger('sys_log', error)
  })
}

// Get order state from exchange
async function sync_bucket( bucket ) {
  update_bucket( bucket, (b) => {
    b.state = 'syncing'
  })
  let data
  try {
    data = await get_order_by_id( bucket.order_id )
  } catch( e ) {
    logger('sys_log', JSON.stringify(e))
  }
  logger('sys_log', data)
  if( data.message && data.message === 'NotFound' ) {
    if( bucket.sync_attempt > 5 ) {
      handle_cancel( data.id )
    } else {
      mark_bucket_done( bucket, bucket.sync_attempt+1 )
    }
    return
  }

  switch( data.status ) {
    case 'done':
      switch( data.done_reason ) {
        case 'filled':
          let trade_data = {
            created_at: new Date(data.done_at),
            side: data.side,
            order_id: data.id,
            trade_size: settings.multipong.trade_size,
            price: parseFloat( data.price ),
            fiat_value: settings.multipong.trade_size * parseFloat(data.price),
            fees: parseFloat(data.fill_fees)
          }
          handle_fill( trade_data )
          break
        case 'canceled':
          handle_cancel( data.id )
          break
        }
        break
    default:
      if( data.filled_size && parseFloat(data.filled_size) > 0 ) {
        let new_state = null
        switch( data.side ) {
          case 'buy':
            new_state = 'partialbuy'
            break
          case 'sell':
            new_state = 'partialsell'
            break
        }
        if( !new_state ) {
          handle_cancel( data.id )
          return
        }
        update_bucket( bucket, (b) => {
          b.state = new_state
        })
      }
      break
  }
}

const mark_bucket_done = ( bucket, attempt=0 ) => {
  update_bucket( bucket, (b) => {
    b.state = 'done'
    b.nextcheck = new Date(new Date().valueOf() + 1000)
    b.sync_attempt = attempt
  })
}

const process_message = (data) => {
  logger('sys_log', data)
  switch( data.type ) {
    case 'done':
      let bucket = _.findWhere( buckets, {order_id: data.order_id} )
      if( !bucket ) return
      if( bucket.state === "canceling" ) {
        if( data.reason === 'canceled' ) {
          handle_cancel( bucket.order_id )
        }
      } else {
        if( data.reason === 'filled' ) {
          mark_bucket_done( bucket )
        }
      }
/*
      switch( data.reason ) {
        case 'filled':
          let trade_data = {
            created_at: new Date(data.time),
            side: data.side,
            order_id: data.order_id,
            price: parseFloat( data.price ),
            trade_size: settings.multipong.trade_size,
            fiat_value: settings.multipong.trade_size * parseFloat(data.price),
          }
          handle_fill( trade_data )
          break
        case 'canceled':
          handle_cancel( data.order_id )
          break
      }
*/
      break
    case 'match':
      handle_match( data )
      break
  }
}

const handle_match = ( match_data ) => {
  logger('sys_log', 'Handling partial match...')
  let order_id = null
  let new_state = null
  switch( match_data.side ) {
    case 'buy':
      order_id = match_data.maker_order_id
      new_state = 'partialbuy'
      break
    case 'sell':
      order_id = match_data.taker_order_id
      new_state = 'partialsell'
      break
  }
  if( !order_id ) return
  let bucket = _.findWhere( buckets, {order_id: order_id} )
  if( !bucket ) return
  update_bucket( bucket, (b) => {
    b.state = new_state
  })
}

const handle_fill = ( trade_data ) => {
  let bucket = _.findWhere(buckets, {order_id: trade_data.order_id})
  if( !bucket ) return
  /*
  if( bucket.fees > 0 ) {
    logger('sys_log', `${trade_data.side} fees @ velocity $${bucket.price_velocity}/s`)
  }*/
  trade_data.price_velocity = bucket.price_velocity
  store_completed_trade( trade_data )
  switch( trade_data.side ) {
    case 'buy':
      logger('sys_log', `Bought bucket ${bucket.idx}`)
      update_bucket(bucket, (b) => {
        b.state = 'full'
        b.order_id = null
      })
      break
    case 'sell':
      logger('sys_log', `Sold bucket ${bucket.idx}`)
      update_bucket(bucket, (b) => {
        b.state = 'empty'
        b.order_id = null
      })
      break
  }
}

const handle_cancel = (order_id) => {
  let bucket = _.findWhere(buckets, {order_id: order_id})
  if( !bucket ) return
  logger('sys_log', `Canceled bucket ${bucket.idx}`)
  switch( bucket.side ) {
    case 'sell':
      update_bucket(bucket, (b) => {
        b.state = 'full'
        b.order_id = null
      })
      break
    case 'buy':
    default:
      update_bucket(bucket, (b) => {
        b.state = 'empty'
        b.order_id = null
      })
      break
  }
}

const retrieve_completed_trades = () => {
  logger('sys_log', 'Loading trade history')
  let old_trades = collections.trades.chain()
    .find()
    .sort( (a, b) => {
      // oldest -> newest
      let date_a = new Date(a.created_at).valueOf()
      let date_b = new Date(b.created_at).valueOf()
      if( date_a === date_b ) {
        return 0
      } else if( date_a > date_b ) {
        return 1
      } else {
        return -1
      }
    })
    //.offset(100)
    //.limit(25)
    .data()
  for( let trade of old_trades ) {
    apply_trade( trade )
  }
}

const apply_trade = ( trade ) => {
  fees += trade.fees
  switch( trade.side ) {
    case 'sell':
      logger('trade_log', `[${moment(trade.created_at).format("MM/DD/YY hh:mm:ss a")}] Sell: +${trade.fiat_value}`)
      current_cash += trade.fiat_value
      sell_count++
      break
    case 'buy':
      logger('trade_log', `[${moment(trade.created_at).format("MM/DD/YY hh:mm:ss a")}] Buy:  -${trade.fiat_value}`)
      current_cash -= trade.fiat_value
      buy_count++
      break
  }
}

const store_completed_trade = ( trade_data ) => {
  collections.trades.insert( trade_data )
  apply_trade( trade_data )
}

/**
 *  Verify if any orders have changed from what we have in the database.
 */
async function validate_buckets() {
  logger('sys_log', 'Syncing old orders with exchange')
  for( let bucket of buckets ) {
    //  If we are in an in-between state, regress
    if( bucket.state === "buying" ) {
      update_bucket(bucket, (b) => {
        b.state = 'empty'
      })
    } else if( bucket.state === "selling" ) {
      update_bucket(bucket, (b) => {
        b.state = 'full'
      })
    }

    if( !bucket.order_id ) continue

    let data = await get_order_by_id( bucket.order_id )
    if( data.message && data.message === 'NotFound' ) {
      handle_cancel( bucket.order_id )
      continue
    }
    switch( data.status ) {
      case 'done':
        switch( data.done_reason ) {
          case 'filled':
            let trade_data = {
              created_at: new Date(data.done_at),
              side: data.side,
              order_id: data.id,
              trade_size: settings.multipong.trade_size,
              price: parseFloat( data.price ),
              fiat_value: settings.multipong.trade_size * parseFloat(data.price),
              fees: parseFloat(data.fill_fees)
            }
            handle_fill( trade_data )
            break
          case 'canceled':
            handle_cancel( data.id )
            break
        }
        break
      default:
        if( data.filled_size && parseFloat(data.filled_size) > 0 ) {
          let new_state = null
          switch( data.side ) {
            case 'buy':
              new_state = 'partialbuy'
              break
            case 'sell':
              new_state = 'partialsell'
              break
          }
          if( !new_state ) {
            handle_cancel( data.id )
            continue
          }
          update_bucket( bucket, (b) => {
            b.state = new_state
          })
        }
        break
    }
  }
}

/**
 *  Generate bucket objects from settings.multipong config
 */
const compute_bucket_distribution = () => {
  let buckets = []
  for( let idx=0; idx<settings.multipong.num_buckets; idx++ ) {
    let bucket = collections.buckets.findOne({idx: idx})
    if( bucket ) {
      buckets.push( bucket )
      continue
    }

    let min = settings.multipong.min_price + (idx*bucket_width)
    let max = min + bucket_width

    let buy_price = parseFloat((min - 0.01).toFixed(2))
    let sell_price = parseFloat((max + 0.01).toFixed(2))
    let trade_size = parseFloat(settings.multipong.trade_size.toPrecision(6))

    bucket = {
      state: 'empty',
      idx,
      min,
      max,
      buy_price,
      sell_price,
      trade_size,
      current_sell_price: 0,
      order_id: null
    }

    bucket = collections.buckets.insert( bucket )
    buckets.push( bucket )
  }
  return buckets
}

const handle_bucket_error = ( bucket, error ) => {
  update_bucket(bucket, (b) => {
    b.order_id = null
  })

  if( error === 'Too small' ) {
    update_bucket(bucket, (b) => {
      b.state = 'toosmall'
    })
    logger('sys_log', 'Disabling bucket due to order size being too small.')
    return true
  }

  if( error === 'Insufficient funds' ) {
    update_bucket(bucket, (b) => {
      b.state = 'insufficientfunds'
      b.nextcheck = new Date(new Date().valueOf() + 1000)
    })
    logger('sys_log', `Insufficient funds to place ${bucket.side} order.`)
    return true
  }

  if( error == 'Unknown error' ) {
    return false
  }

  return false
}

/**
 *  Update a property on a bucket and make sure it is persisted in the DB.
 */
const update_bucket = (bucket, mutation) => {
  mutation(bucket)
  collections.buckets.update(bucket)
}

const get_order_by_id = ( order_id ) => {
  return new Promise( (resolve, reject) => {
    gdax_private.getOrder( order_id, (error, response, data) => {
      if( error ) {
        reject( error )
        return
      }
      resolve( data )
    } )
  })
}

/**
 *  Send a limit order to GDAX
 */
const limit_order = (side, product_id, price, bucket) => {
  update_bucket( bucket, (b) => {
    b.price_velocity = midmarket_price.velocity
  })
  let size = bucket.trade_size
  return new Promise( (resolve, reject) => {
    let order = {
      price: price.toFixed(2),    // fiat
      size: size.toString(),      // coin
      product_id,
      type: 'limit'
    }
    gdax_private[side](order, (error, response, data) => {
      if( error || data === null ) {
        reject(error)
        return
      }
      if( data['message'] ) {
        if( data['message'].indexOf('Order size is too small') !== -1 ) {
          reject('Too small')
          return
        } else if( data['message'].indexOf('Insufficient funds') !== -1 ) {
          reject('Insufficient funds')
        } else {
          logger('sys_log', data)
          reject('Unknown error')
        }
      }
      resolve(data)
    })
  })
}

const buy_bucket = ( bucket ) => {
  if( bucket.buy_price > (midmarket_price.current - (bucket_width*0.3)) ) return
  update_bucket(bucket, (b) => {
    b.state = 'buying'
    b.side = 'buy'
    b.current_sell_price = 0
  })
  logger('sys_log', `Buying bucket ${bucket.idx}`)//` ${bucket.trade_size} at $${bucket.buy_price}\t($${bucket.buy_price*bucket.trade_size})`)
  limit_order('buy', settings.product_id, bucket.buy_price, bucket)
  .then( (data) => {
    logger('sys_log', data)
    update_bucket(bucket, (b) => {
      b.state = 'ping'
      b.order_id = data.id
      b.fees = parseFloat( data.fill_fees ) || 0
    })
  })
  .catch( (error) => {
    if( handle_bucket_error( bucket, error ) ) return
    update_bucket(bucket, (b) => {
      b.state = 'empty'
    })
    logger('sys_log', error)
  })
}

const sell_bucket = ( bucket, high_price=null ) => {
  let sell_price = high_price || bucket.sell_price
  update_bucket(bucket, (b) => {
    b.state = 'selling'
    b.side = 'sell'
    b.current_sell_price = sell_price
  })
  logger('sys_log', `Selling bucket ${bucket.idx}`)//` ${bucket.trade_size} at $${sell_price}\t($${sell_price*bucket.trade_size})`)
  //return
  limit_order('sell', settings.product_id, sell_price, bucket )
  .then( (data) => {
    logger('sys_log', data)
    update_bucket(bucket, (b) => {
      b.state = 'pong'
      b.order_id = data.id
      b.fees = parseFloat( data.fill_fees ) || 0
    })
  })
  .catch( (error) => {
    if( handle_bucket_error( bucket, error ) ) return
    update_bucket(bucket, (b) => {
      b.state = 'full'
    })
    logger('sys_log', error)
  })
}

const cancel_bucket = ( bucket ) => {
  logger('sys_log', `Canceling bucket ${bucket.idx}`)
  update_bucket( bucket, (b) => {
    b.state = 'canceling'
    b.nextcheck = new Date(new Date().valueOf() + 10000)
  })
  gdax_private.cancelOrder(bucket.order_id)
}

const trade_buckets = () => {
  for( let idx = buckets.length-1; idx>=0; idx-- ) {
    let bucket = buckets[idx]
    if( !midmarket_price.current ) {
      logger('sys_log', `Midmarket price data unavailable. Skipping buy order for $${bucket.buy_price}.`)
      return
    }

    switch( bucket.state ) {
      case 'empty': // need to buy!
        if( bucket.buy_price < (midmarket_price.current-0.01) && midmarket_price.current < (bucket.sell_price+2*bucket_width) ) {
          buy_bucket(bucket)
        } /*else {
          logger('sys_log', `Cannot buy at $${bucket.buy_price} (Midmarket @ $${midmarket_price.current})`)
        }*/
        break
      case 'full': // need to sell!
        if( bucket.sell_price < midmarket_price.current ) {
          sell_bucket( bucket, (midmarket_price.current+3*bucket_width) )
        } else {
          sell_bucket( bucket )
        }
        break
      case 'ping': // free up cash that's not about to be used
        if( (bucket.sell_price+2*bucket_width) < midmarket_price.current ) {
          cancel_bucket( bucket )
        }
        break
      case 'canceling': // check on buckets that may get stuck
        if( new Date() >= new Date(bucket.nextcheck) ) {
          //sync_bucket_with_exchange( bucket )
        }
      case 'done': // bucket needs to be synced with exchange to get final trade data
        if( new Date() >= new Date(bucket.nextcheck) ) {
          sync_bucket( bucket )
        }
        break
      case 'insufficientfunds':
        if( new Date() >= new Date(bucket.nextcheck) ) {
          logger('sys_log', `Bucket ${bucket.idx} is resetting from insufficientfunds.`)
          switch( bucket.side ) {
            case 'buy':
              update_bucket(bucket, (b) => {
                delete b.nextcheck
                b.state = 'empty'
              })
              break
            case 'sell':
              update_bucket(bucket, (b) => {
                delete b.nextcheck
                b.state = 'full'
              })
              break
          }
        }
        break
    }
  }
}

const init_trading = () => {
  logger('sys_log', 'Beginning to trade.')
  setInterval( () => {
    trade_buckets()
  }, settings.multipong.trade_period)
}

//  Entry Point
let buckets
function start_app() {
  init_orderbook()
  buckets = compute_bucket_distribution()
  validate_buckets()
  init_ws_stream()
  wait_for_orderbook_sync()
}

init_screen()
init_db()
