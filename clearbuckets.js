const loki = require('lokijs')

let db_file
function init_db() {
  db = new loki(db_file, {
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
  db_set('buckets')
  collections.buckets.clear()
  setTimeout( () => {
    process.exit()
  }, 500)
}

if( process.argv.length < 2 ) {
  console.log(`Please enter the currency trade database you'd like to reset as an argument!`)
  console.log(`Usage:\tnode clearbuckets.js BTC | ETH | LTC`)
  process.exit(0)
}
let coin = process.argv[2]
db_file = `${coin.toUpperCase()}-USD.db`
init_db()
