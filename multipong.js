settings = {}
fs = require("fs")
_ = require('underscore')
moment = require('moment-timezone')
gdax = require('./gdax')
ui = require('./ui')
db = require('./db')
account = require('./account')
buckets = require('./buckets')
trades = require('./trades')

log = {}

trade_data = {
  buys: {
    enabled: false
  },
  sells: {
    enabled: false
  }
}

let bucket_timer
let trade_timer

/**
 *
 */
load_settings = () => {
  settings = JSON.parse( fs.readFileSync("settings.json", "utf8") )
  settings.product_id = `${settings.multipong.coin}-${settings.multipong.fiat}`
  settings.bucket_width = (settings.multipong.max_price - settings.multipong.min_price)/settings.multipong.num_buckets
  settings.cash_per_bucket = settings.multipong.initial_cash/settings.multipong.num_buckets
  if( log.file ) log.file.end()
  log.file = fs.createWriteStream(`${settings.product_id}.log`)

  db.init(settings.product_id)
  .then( () => {
    account.load()
    buckets.load()
    trades.load()

    gdax.init()
    return gdax.wait_for_orderbook_sync()
  })
  .then( () => {
    if( trade_timer ) clearInterval( trade_timer )
    trade_timer = setInterval( trades.process_trades, 100 )
    if( bucket_timer ) clearInterval( bucket_timer )
    return trades.wait_for_all_trades_to_sync()
  })
  .then( () => {
    ui.logger('sys_log', 'Trade engine initialized')
    ui.logger('sys_log', 'Press "b" to enable crypto buys.')
    ui.logger('sys_log', 'Press "s" to enable crypto sells.')
    bucket_timer = setInterval( buckets.process_buckets, 100 )
  })
}

ui.init()
load_settings()

exit_gracefully = () => {
  ui.logger('sys_log', 'Exiting...')
  //cancel_all_buys()
  db.close()
  log.file.end()
  return process.exit(0)
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
      logger('trade_log', `[${moment(trade.created_at).tz(settings.tz).format("MM/DD/YY hh:mm:ss a")}] Sell: +${trade.fiat_value}`)
      current_cash += trade.fiat_value
      sell_count++
      break
    case 'buy':
      logger('trade_log', `[${moment(trade.created_at).tz(settings.tz).format("MM/DD/YY hh:mm:ss a")}] Buy:  -${trade.fiat_value}`)
      current_cash -= trade.fiat_value
      buy_count++
      break
  }
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
