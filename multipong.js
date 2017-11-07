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
    trade_timer = setInterval( trades.process_trades, 500 )
    if( bucket_timer ) clearInterval( bucket_timer )
    return trades.wait_for_all_trades_to_sync()
  })
  .then( () => {
    ui.logger('sys_log', 'Trade engine initialized')
    ui.logger('sys_log', 'Press "b" to enable crypto buys.')
    ui.logger('sys_log', 'Press "s" to enable crypto sells.')
    bucket_timer = setInterval( buckets.process_buckets, 500 )
  })
}

exit_gracefully = () => {
  ui.logger('sys_log', 'Exiting...')
  //cancel_all_buys()
  db.close()
  log.file.end()
  return process.exit(0)
}

ui.init()
load_settings()
