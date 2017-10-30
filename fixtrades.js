const loki = require('lokijs')

function init_db() {
  db = new loki('db.json', {
  	autoload: true,
    autoupdate: true,
  	autoloadCallback: init_db_cb,
  	autosave: true,
  	autosaveInterval: 200
  })
}

let collections = {}
function db_set(collection) {
  collections[collection] = db.getCollection(collection)
  if( collections[collection] === null ) {
    collections[collection] = db.addCollection(collection)
  }
}

function init_db_cb() {
  db_set('trades')

  function old_trade_filter(trade) {
    return new Date(trade.created_at) < new Date(new Date().valueOf() - (16*60*1000))
  }

  // and then pass that
  trades = collections.trades.where(old_trade_filter)
  console.dir(trades)
}

init_db()
