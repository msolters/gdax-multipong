const creds = JSON.parse( fs.readFileSync("credentials.json", "utf8") )
const gdax = require('gdax')
const gdax_private = new gdax.AuthenticatedClient(creds.gdax.api.key, creds.gdax.api.secret, creds.gdax.api.passphrase, creds.gdax.api.uri)

exports = module.exports = {}

/**
 *  Market Data
 */
let orderbook
exports.orderbook_synced = false
let price_timer
let gdax_ws
const midmarket_price = exports.midmarket_price = {
  current: null,
  velocity: 0.0
}

const init = exports.init = () => {
  disconnect()
  init_orderbook()
  init_ws_stream()
}

const disconnect = exports.disconnect = () => {
  if( price_timer ) clearInterval( price_timer )
  if( gdax_ws ) {
    gdax_ws.removeAllListeners('close')
    try {
      gdax_ws.disconnect()
    } catch( e ) {
      //ui.logger('sys_log', JSON.stringify(e))
    }
  }
  if( orderbook ) {
    orderbook.removeAllListeners('close')
    try {
      orderbook.disconnect()
    } catch( e ) {
      //ui.logger('sys_log', JSON.stringify(e))
    }
  }
}

const init_ws_stream = () => {
  gdax_ws = new gdax.WebsocketClient([settings.product_id], 'wss://ws-feed.gdax.com', {
    key: creds.gdax.api.key,
    secret: creds.gdax.api.secret,
    passphrase: creds.gdax.api.passphrase,
  }, {
    heartbeat: true,
    channels: ['user', 'heartbeat']
  })

  gdax_ws.on('message', (data) => {
    switch( data.type ) {
      case "heartbeat":
      case "subscriptions":
        return
        break
      default:
        process_ws_message(data)
        break
    }
  })

  gdax_ws.on('error', (error) => {
    ui.logger('sys_log', error)
  })

  gdax_ws.on('close', (data) => {
    ws_reconnect(gdax_ws, data)
  })
}

const ws_reconnect = (ws, data) => {
  ui.logger('sys_log', `GDAX websocket disconnected with data: ${data}`)
  // try to re-connect the first time...
  ui.logger('sys_log', 'Reconnecting to GDAX')
  ws.connect()
  let count = 1
  // attempt to re-connect every 30 seconds.
  // TODO: maybe use an exponential backoff instead
  const interval = setInterval(() => {
    if (!ws.socket) {
      ui.logger('sys_log', `Reconnecting to GDAX (attempt ${count++})`)
      //count++
      ws.connect()
    } else {
      ui.logger('sys_log', 'GDAX reconnected')
      clearInterval(interval)
    }
  }, 10000)
}

const set_midmarket_price = () => {
  if( !orderbook ) return
  let max_bid = orderbook.books[settings.product_id]._bids.max()
  let min_ask = orderbook.books[settings.product_id]._asks.min()
  if(!max_bid || !min_ask) {
    return null
  }
  if(!exports.orderbook_synced) {
    exports.orderbook_synced = true
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
  exports.orderbook_synced = false
  ui.logger('sys_log', `Loading ${settings.product_id} order book`)
  orderbook = new gdax.OrderbookSync([settings.product_id])
  orderbook.on('close', (data) => {
    ws_reconnect(orderbook, data)
  })
  if( price_timer ) clearInterval( price_timer )
  price_timer = setInterval( set_midmarket_price, settings.multipong.midmarket_price_period )
}

const wait_for_orderbook_sync = exports.wait_for_orderbook_sync = () => {
  return new Promise(function(resolve, reject) {
    let timer
    function check_if_ready() {
      if( exports.orderbook_synced ) {
        clearInterval(timer)
        resolve()
      }
    }
    timer = setInterval( check_if_ready, 1000 )
  })
}

/**
 *  Get information about an order from GDAX by it's ID
 */
const get_order_by_id = exports.get_order_by_id = ( order_id ) => {
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
const limit_order = exports.limit_order = (side, product_id, price, size) => {
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
          ui.logger('sys_log', data)
          reject('Unknown error')
        }
      }
      resolve(data)
    })
  })
}

/**
 *  Cancel an order pending in GDAX
 */
const cancel_order = exports.cancel_order = ( order_id ) => {
  ui.logger('sys_log', `Canceling order ${order_id}`)
  gdax_private.cancelOrder(order_id)
}

/**
 *
 */
const process_ws_message = (data) => {
  ui.logger('sys_log', data)
  switch( data.type ) {
    case 'done': {
      let trade = _.findWhere( _.values(trades.trades), {active_order_id: data.order_id} )
      if( !trade ) return
      switch( data.reason ) {
        case 'canceled':
        case 'filled':
          trades.mark_trade_for_sync( trade )
          break
      }
    } break
    case 'match': {
      ui.logger('sys_log', 'Handling partial match...')
      let order_id = null
      switch( data.side ) {
        case 'buy':
          order_id = data.maker_order_id
          break
        case 'sell':
          order_id = data.taker_order_id
          break
      }
      if( !order_id ) return
      let trade = _.findWhere( _.values(trades.trades), {active_order_id: order_id} )
      if( !trade ) return
      trades.trade_partial_fill( trade )
    } break
  }
}

const handle_cancel = (order_id) => {
  let bucket = _.findWhere(buckets, {order_id: order_id})
  if( !bucket ) return
  ui.logger('sys_log', `Canceled bucket ${bucket.idx}`)
  reset_bucket( bucket )
}
