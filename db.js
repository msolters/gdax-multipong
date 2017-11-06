const loki = require('lokijs')

let db

exports = module.exports = {}

const collections = exports.collections = {}

const init = exports.init = (filename) => {
  if( db ) close()
  ui.logger('sys_log', 'Initializing database')
  return new Promise( (resolve, reject) => {
    function db_cb() {
      init_collection('settings')
      init_collection('account')
      init_collection('buckets')
      init_collection('trades')
      resolve()
    }

    db = new loki(`${filename}.db`, {
      autoload: true,
      autoupdate: true,
      autoloadCallback: db_cb,
      autosave: true,
      autosaveInterval: 1000
    })
  })
}

/**
 *  Ensure a collection exists in the DB and that a reference to it exists
 *  in the collections object.
 */
const init_collection = exports.init_collection = (collection_name) => {
  collections[collection_name] = db.getCollection(collection_name)
  if( collections[collection_name] === null ) {
    collections[collection_name] = db.addCollection(collection_name)
  }
}

const close = exports.close = () => {
  db.close()
}
