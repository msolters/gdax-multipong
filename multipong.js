fs = require("fs")
settings = JSON.parse( fs.readFileSync("settings.json", "utf8") )
const gdax = require('gdax')
const _ = require('underscore')
//const gdax_public = new gdax
const gdax_private = new gdax.AuthenticatedClient(settings.gdax.api.key, settings.gdax.api.secret, settings.gdax.api.passphrase, settings.gdax.api.uri)

const coin = 'ETH'
settings.product_id = `${coin}-USD`

//  Listen for fills
const gdax_ws = new gdax.WebsocketClient([settings.product_id],
'wss://ws-feed.gdax.com',
{
  key: settings.gdax.api.key,
  secret: settings.gdax.api.secret,
  passphrase: settings.gdax.api.passphrase,
}, {
  heartbeat: true,
  channels: ['user']
})

const process_message = (data) => {
  switch( data.type ) {
    case 'open':
      //  order is ready!
      break
    case 'received':
      break
    case //filled:

      break
  }
}

gdax_ws.on('message', (data) => {
  console.log(data)
  //process_message(data)
})
gdax_ws.on('error', (error) => {
  console.error(error)
})

const total_cash = 150
const num_buckets = 10
const min_price = 1000
const max_price = 2000
const cash_per_bucket = total_cash/num_buckets

//  Initialize buckets
let buckets = {}
for( let bkt_idx=0; bkt_idx<num_buckets; bkt_idx++ ) {
  let min = min_price + (bkt_idx*cash_per_bucket)
  let max = min + cash_per_bucket
  let buy_price = min + (cash_per_bucket*0.25)
  let sell_price = min + (cash_per_bucket*0.75)
  let trade_size = cash_per_bucket/buy_price
  trade_size = trade_size.toPrecision(7)

  buckets[bkt_idx] = {
    min,
    max,
    available: true,
    buy_price,
    sell_price,
    trade_size
  }
  //console.log(trade_size* (sell_price - buy_price))
}

let last_bucket = buckets[num_buckets-1]
if( last_bucket.trade_size < 0.01 ) {
  console.log(`Insufficient cash on hand!  We need $${last_bucket.buy_price * 0.01}`)
}

//  Cancel all open trades (just buys?)
const limit_order = (side, product_id, price, size) => {
  return new Promise( (resolve, reject) => {
    let order = {
      price: price.toString(),    // USD
      size: size.toString(),      // coin
      product_id,
      type: 'limit'
    }
    switch( side ) {
      case 'buy':
        gdax_private.buy(order, (error, response, data) => {
          if( error ) {
            reject(error)
            return
          }
          resolve(data)
        })
        break
      case 'sell':
        gdax_private.sell(order, (error, response, data) => {
          if( error ) {
            reject(error)
            return
          }
          resolve(data)
        })
        break
    }
  })
}

//  Send a buy order for each bucket
const order_all_buckets = () => {
  for( let b in buckets ) {
    console.log(buckets[b])
    limit_order('buy', settings.product_id, buckets[b].buy_price, buckets[b].trade_size)
    .then( (data) => {
      console.dir(data)
      buckets[b].available = true
      buckets[b].order_id = data.id
    })
    .catch( (error) => {
      console.error(error)
    })
  })
}

/*
limit_order('buy', 'BTC-USD', 2000, 0.1)
.then( (data) => {
  console.dir(data)
})
.catch( (error) => {
  console.error(error)
})*/
