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
  db_set('buckets')
  collections.buckets.clear()
  setTimeout( () => {
    process.exit()
  }, 500)
}

init_db()
