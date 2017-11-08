exports = module.exports = {}

exports.buckets = []

const load = exports.load = () => {
  let stored_config = db.collections.settings.findOne()
  if( stored_config ) {
    //  Check to see if settings.json differs from previous settings
    if( !( (settings.multipong.min_price === stored_config.min_price) && (settings.multipong.max_price === stored_config.max_price) && (settings.multipong.num_buckets === stored_config.num_buckets) && (settings.multipong.trade_size === stored_config.trade_size) ) ) {
      //  Buckets are now different! Recompute them.
      stored_config.min_price = settings.multipong.min_price
      stored_config.max_price = settings.multipong.max_price
      stored_config.num_buckets = settings.multipong.num_buckets
      stored_config.trade_size = settings.multipong.trade_size
      db.collections.settings.update(stored_config)
      compute()
    } else {
      //  Just copy buckets from disk into exports.buckets
      exports.buckets = db.collections.buckets.chain()
      .find()
      .sort( (a, b) => {
        // cheap->expensive
        let min_price_a = a.min_price
        let min_price_b = b.min_price
        if( min_price_a === min_price_b ) {
          return 0
        } else if( min_price_a > min_price_b ) {
          return 1
        } else {
          return -1
        }
      })
      .data()
    }
  } else {
    //  Create a new buckets if there weren't any to begin with.
    let new_config = {
      min_price: settings.multipong.min_price,
      max_price: settings.multipong.max_price,
      num_buckets: settings.multipong.num_buckets,
      trade_size: settings.multipong.trade_size,
    }
    db.collections.settings.insert( new_config )
    compute()
  }
}

/**
 *  Compute and store a new bucket distribution in the DB
 */
const compute = exports.compute = () => {
  exports.buckets = []
  db.collections.buckets.clear()
  for( let idx=0; idx<settings.multipong.num_buckets; idx++ ) {
    let min = settings.multipong.min_price + (idx*settings.bucket_width)
    let max = min + settings.bucket_width

    let buy_price = parseFloat((min - 0.01).toFixed(2))
    let sell_price = parseFloat((max + 0.01).toFixed(2))

    let bucket = {
      min_price: buy_price,
      max_price: sell_price,
      trade_id: null
    }

    bucket = db.collections.buckets.insert( bucket )
    exports.buckets.push( bucket )
  }
}

const valid_buy_price = exports.valid_buy_price = (price) => {
  if( (price < gdax.midmarket_price.current) &&
      (price > gdax.midmarket_price.current - (settings.multipong.bucket_runway*settings.bucket_width) ) ) {
    return true
  }
  return false
}

/**
 *  Check all buckets to see if any should be traded
 */
const process_buckets = exports.process_buckets = () => {
  for( let bucket_idx=exports.buckets.length; bucket_idx>0; bucket_idx-- ) {
    let bucket = exports.buckets[bucket_idx-1]
    if( isNaN( gdax.midmarket_price.current ) ) return
    if( bucket.trade_id === null ) {
      //  Do we need to trade in this bucket?
      //ui.logger('sys_log', `Considering buying at ${bucket.min_price}`)
      if( valid_buy_price( bucket.min_price ) ) {
        //ui.logger('sys_log', `We should be trading at ${bucket.min_price}`)
        trade_id = trades.create_trade(settings.multipong.trade_size, bucket.min_price, bucket.max_price)
        update( bucket, (b) => {
          b.trade_id = trade_id
        })
      }
    }
  }
}

/**
 *  Update a property on a bucket and make sure it is persisted in the DB.
 */
const update = exports.update = (bucket, mutation) => {
  mutation(bucket)
  //ui.logger('sys_log', `update_bucket: ${JSON.stringify(bucket)}`)
  try {
    db.collections.buckets.update(bucket)
  } catch( e ) {
    ui.logger('sys_log', JSON.stringify(e))
  }
}
