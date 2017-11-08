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

const stop_buys_and_sells = () => {
  if( trade_timer ) clearInterval( trade_timer )
  trade_data = {
    buys: {
      enabled: false
    },
    sells: {
      enabled: false
    }
  }
}

/**
 *  Read settings.json
 */
const load_settings = () => {
  ui.logger('sys_log', 'Loading settings.json')
  return new Promise(function(resolve, reject) {
    let new_settings = JSON.parse( fs.readFileSync("settings.json", "utf8") )
    new_settings.product_id = `${new_settings.multipong.coin}-${new_settings.multipong.fiat}`
    new_settings.bucket_width = (new_settings.multipong.max_price - new_settings.multipong.min_price)/new_settings.multipong.num_buckets
    resolve(new_settings)
  })
}

const load_db = () => {
  return new Promise( (resolve, reject) => {
    db.init(settings.product_id)
    .then( () => {
      ui.logger('sys_log', 'Initializing account information')
      account.load()
      ui.logger('sys_log', 'Initializing buckets')
      buckets.load()
      ui.logger('sys_log', 'Initializing trade data')
      trades.load()
      resolve()
    })
  })
}

reload_config = () => {
  ui.logger('sys_log', 'Multipong is initializing')
  let new_currency_flag = true
  //  Reset app state
  if( bucket_timer ) clearInterval( bucket_timer )
  //  Read from settings.json
  load_settings()
  //  Initialize disk resources (DBs, logs)
  .then( (new_settings) => {
    //  Are we trading a new currency pair?
    if( settings.product_id && new_settings.product_id === settings.product_id ) {
      new_currency_flag = false
      ui.logger('sys_log', `Multipong is continuing to trade ${new_settings.product_id}`)
      settings = new_settings
      buckets.load()
    } else {
      ui.logger('sys_log', `Currency pair is now ${new_settings.product_id}`)
      //  Stop trade processing
      stop_buys_and_sells()
      //  Disconnect from GDAX
      gdax.disconnect()
      //  Initialize log file
      let log_file_name = `${new_settings.product_id}.log`
      ui.logger('sys_log', `Initializing log output: ${log_file_name}`)
      if( log.file ) log.file.end()
      log.file = fs.createWriteStream(log_file_name)
      //  Initialize settings object
      settings = new_settings
      //  Initialize database
      return load_db()
    }
  })
  .then( () => {
    if( new_currency_flag ) {
      ui.logger('sys_log', 'Connecting to GDAX')
      gdax.init()
      return gdax.wait_for_orderbook_sync()
    } else {
      ui.logger('sys_log', 'GDAX is already initialized')
    }
  })
  .then( () => {
    if( !trade_timer ) {
      trade_timer = setInterval( trades.process_trades, 500 )
    }
    return trades.wait_for_all_trades_to_sync()
  })
  .then( () => {
    ui.logger('sys_log', 'Trade engine ready')
    if( !trade_data.buys.enabled && !trade_data.sells.enabled ) {
      ui.logger('sys_log', 'Press "b" to enable crypto buys.')
      ui.logger('sys_log', 'Press "s" to enable crypto sells.')
    }
    bucket_timer = setInterval( buckets.process_buckets, 500 )
  })
  .catch( (error) => {
    ui.logger('sys_log', JSON.stringify(error))
    exit_gracefully()
  })
}

exit_gracefully = () => {
  ui.logger('sys_log', 'Exiting...')
  // TODO: cancel all buys on exit?
  //cancel_all_buys()
  db.close()
  log.file.end()
  return process.exit(0)
}

//  Load basic settings we absolutely need at boot
let {tz} = JSON.parse( fs.readFileSync("settings.json", "utf8") )
settings.tz = tz

ui.init()
reload_config()
