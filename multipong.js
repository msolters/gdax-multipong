fs = require("fs")
settings = JSON.parse( fs.readFileSync("settings.json", "utf8") )
const gdax = require('gdax')
const _ = require('underscore')
const moment = require('moment')
const gdax_private = new gdax.AuthenticatedClient(settings.gdax.api.key, settings.gdax.api.secret, settings.gdax.api.passphrase, settings.gdax.api.uri)
const blessed = require('blessed')
const contrib = require('blessed-contrib')
const loki = require('lokijs')
const collections = {}
let db

const bucket_width = (settings.multipong.max_price - settings.multipong.min_price)/settings.multipong.num_buckets
const cash_per_bucket = settings.multipong.initial_cash/settings.multipong.num_buckets
let db_trades, db_buckets
let midmarket_price = null
let orderbook_synced = false
let current_cash = settings.multipong.initial_cash
let buy_count = 0
let sell_count = 0
settings.product_id = `${settings.multipong.coin}-USD`

/**
 *  Database
 */
function init_db() {
  logger('sys_log', 'Initializing database')
  db = new loki('db.json', {
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
    border: {type: 'line', fg: 'blue'},
    fg: 'blue',
    interactive: false,
    columnSpacing: 4,               //in chars
    columnWidth: [14, 12, 12, 12, 6, 6],  // in chars
  })
  ui.bucket_table = contrib.table({
    keys: true,
    fg: 'blue',
    interactive: false,
    label: 'Trade Buckets',
    width: '46%',
    height: '96%',
    top: '2%',
    left: '52%',
    border: {type: "line", fg: "blue"},
    columnSpacing: 4, //in chars
    columnWidth: [12, 12, 12, 17, 36], /*in chars*/
  })
  ui.trade_log = contrib.log({
    fg: "blue",
    selectedFg: "blue",
    label: 'Trade Log',
    left: '2%',
    top: '17%',
    width: '46%',
    height: '28%',
    border: {type: "line", fg: "blue"}
  })
  ui.sys_log = contrib.log({
    fg: "blue",
    selectedFg: "blue",
    label: 'System Log',
    left: '2%',
    top: '47%',
    width: '46%',
    height: '51%',
    border: {type: "line", fg: "blue"}
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
    let row = [`$${bucket.buy_price}`, `$${bucket.sell_price}`, bucket.trade_size, bucket.state, order_id]
    table_data.push( row )
  }

  ui.bucket_table.setData({
    headers: ['Buy Price', 'Sell Price', 'Order Size', 'State', 'Order ID'],
    data: table_data
  })
}

const refresh_overview_table = () => {
  let current_price = 'Loading'
  if( orderbook_synced ) current_price = `$${midmarket_price.toFixed(3)}`
  ui.overview_table.setData({
    headers: [`${settings.product_id} Price`, 'Initial Cash', 'Cash on Hand', 'Net Gain', 'Buys', 'Sells'],
    data: [[current_price, `$${settings.multipong.initial_cash}`, `$${current_cash.toFixed(4)}`, `$${(current_cash-settings.multipong.initial_cash).toPrecision(4)}`, buy_count, sell_count]]
  })
}

const logger = (target, content) => {
  if( settings.multipong.DEBUG ) {
    console.log(content)
    return
  }
  if( typeof content !== 'string' ) {
    content = JSON.stringify(content)
  }
  ui[target].log(`${moment().format('HH:mm:ss')} ${content}`)
}

/**
 *  Market Data
 */
const orderbook = new gdax.OrderbookSync([settings.product_id])

const get_midmarket_price = () => {
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
  return new_midmarket_price
}

const init_orderbook = () => {
  logger('sys_log', `Loading ${settings.product_id} order book`)
  setInterval( () => {
    midmarket_price = get_midmarket_price()
  }, settings.midmarket_price_period )
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

const handle_fill = ( trade_data ) => {
  let bucket = _.findWhere(buckets, {order_id: trade_data.order_id})
  if( !bucket ) return
  trade_data.trade_size = bucket.trade_size
  store_completed_trade( trade_data )
  switch( trade_data.side ) {
    case 'buy':
      update_bucket(bucket, (b) => {
        b.state = 'full'
      })
      break
    case 'sell':
      update_bucket(bucket, (b) => {
        b.state = 'empty'
      })
      break
  }
}

const apply_trade = ( trade ) => {
  switch( trade.side ) {
    case 'sell':
      logger('trade_log', `[${moment(trade.created_at).format("MM/DD/YY hh:mm:ss a")}] Sell: +${trade.usd_value}`)
      current_cash += trade.usd_value
      sell_count++
      break
    case 'buy':
      logger('trade_log', `[${moment(trade.created_at).format("MM/DD/YY hh:mm:ss a")}] Buy:  -${trade.usd_value}`)
      current_cash -= trade.usd_value
      buy_count++
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

const store_completed_trade = ( trade_data ) => {
  collections.trades.insert( trade_data )
  apply_trade( trade_data )
}

const handle_cancel = (order_id) => {
  let bucket = _.findWhere(buckets, {order_id: order_id})
  if( !bucket ) return
  switch( bucket.side ) {
    case 'sell':
      update_bucket(bucket, (b) => {
        b.state = 'full'
      })
      break
    case 'buy':
    default:
      update_bucket(bucket, (b) => {
        b.state = 'empty'
      })
      break
  }
}

const process_message = (data) => {
  logger('sys_log', data)
  switch( data.type ) {
    case 'done':
      switch( data.reason ) {
        case 'filled':
          let trade_data = {
            created_at: new Date(data.time),
            side: data.side,
            usd_value: parseFloat(data.trade_size) * parseFloat(data.price),
            order_id: data.order_id,
            price: parseFloat( data.price )
          }
          handle_fill( trade_data )
          break
        case 'canceled':
          handle_cancel( data.order_id )
          break
      }
      break
  }
}

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

    let buy_price = min - 0.01
    let sell_price = max + 0.01
    let trade_size = parseFloat(settings.multipong.trade_size.toPrecision(6))

    bucket = {
      state: 'empty',
      idx,
      min,
      max,
      buy_price,
      sell_price,
      trade_size,
      order_id: null
    }

    bucket = collections.buckets.insert( bucket )
    buckets.push( bucket )
  }
  return buckets
}

const limit_order = (side, product_id, price, size) => {
  return new Promise( (resolve, reject) => {
    let order = {
      price: price.toString(),    // USD
      size: size.toString(),      // coin
      product_id,
      type: 'limit'
    }
    gdax_private[side](order, (error, response, data) => {
      if( error ) {
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
          reject('Unknown error')
        }
      }
      resolve(data)
    })
  })
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
      b.nextcheck = new Date(new Date().valueOf() + 1000*30)
    })
    logger('sys_log', 'Insufficient funds to place buy order.')
    return true
  }

  if( error == 'Unknown error' ) {
    return true
  }

  return false
}

const buy_bucket = ( bucket ) => {
  update_bucket(bucket, (b) => {
    b.state = 'buying'
    b.side = 'buy'
  })
  logger('sys_log', `Buying  ${bucket.trade_size} at $${bucket.buy_price}\t($${bucket.buy_price*bucket.trade_size})`)
  limit_order('buy', settings.product_id, bucket.buy_price, bucket.trade_size)
  .then( (data) => {
    logger('sys_log', data)
    update_bucket(bucket, (b) => {
      b.state = 'ping'
      b.order_id = data.id
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

const cancel_bucket = ( bucket ) => {
  logger('sys_log', 'Cancelling bucket ${bucket.order_id}')
  update_bucket( bucket, (b) => {
    b.state = 'canceling'
  })
  gdax_private.cancelOrder(bucket.order_id)
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
    if( data.status === 'done' ) {
      switch( data.done_reason ) {
        case 'filled':
          let trade_data = {
            created_at: new Date(data.done_at),
            side: data.side,
            usd_value: parseFloat(data.size) * parseFloat(data.price),
            order_id: data.id,
            trade_size: bucket.trade_size,
            price: parseFloat( data.price )
          }
          handle_fill( trade_data )
          break
        case 'canceled':
          handle_cancel( data.id )
          break
      }
    }
  }
}

const sell_bucket = ( bucket, high_price=null ) => {
  let sell_price = high_price || bucket.sell_price
  bucket.state = 'selling'
  update_bucket(bucket, (b) => {
    b.state = 'selling'
    b.side = 'sell'
  })
  logger('sys_log', `Selling ${bucket.trade_size} at $${sell_price}\t($${sell_price*bucket.trade_size})`)
  //return
  limit_order('sell', settings.product_id, sell_price, bucket.trade_size )
  .then( (data) => {
    update_bucket(bucket, (b) => {
      b.state = 'pong'
      b.order_id = data.id
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

const trade_buckets = () => {
  for( let bucket of buckets ) {
    if( !midmarket_price ) {
      logger('sys_log', `Midmarket price data unavailable. Skipping buy order for $${bucket.buy_price}.`)
      return
    }

    switch( bucket.state ) {
      case 'empty': // need to buy!
        if( bucket.buy_price < midmarket_price && midmarket_price < bucket.sell_price ) {
          buy_bucket(bucket)
        } /*else {
          logger('sys_log', `Cannot buy at $${bucket.buy_price} (Midmarket @ $${midmarket_price})`)
        }*/
        break
      case 'full': // need to sell!
        if( bucket.sell_price < midmarket_price ) {
          sell_bucket( bucket, midmarket_price )
        } else {
          sell_bucket( bucket )
        }
        break
      case 'ping':
        if( bucket.sell_price < midmarket_price ) {
          cancel_bucket( bucket )
        }
        break
      case 'insufficientfunds':
        if( new Date() >= new Date(bucket.nextcheck) ) {
          logger('sys_log', `Bucket is ready again!`)
          update_bucket(bucket, (b) => {
            delete b.nextcheck
            b.state = 'empty'
          })
        }
        break
    }
  }
}

const init_trading = () => {
  logger('sys_log', 'Beginning to trade.')
  setInterval( () => {
    trade_buckets()
  }, 500)
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
