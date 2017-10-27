fs = require("fs")
settings = JSON.parse( fs.readFileSync("settings.json", "utf8") )
const gdax = require('gdax')
const _ = require('underscore')
const moment = require('moment')
const Coinbase = require('coinbase')
const Client = Coinbase.Client
const Account = Coinbase.model.Account

const blessed = require('blessed')
const contrib = require('blessed-contrib')
//const screen = blessed.screen()

const coinbase_client = new Client({
  'apiKey': settings.coinbase.api.key,
  'apiSecret': settings.coinbase.api.secret,
  'version': settings.coinbase.api.version
})
const gdax_private = new gdax.AuthenticatedClient(settings.gdax.api.key, settings.gdax.api.secret, settings.gdax.api.passphrase, settings.gdax.api.uri)

const get_spot_price = exports.get_spot_price = ( coins ) => {
  if( !Array.isArray(coins) ) {
    coins = [ coins ]
  }
  let prices = {}
  return new Promise( (resolve, reject) => {
    for( let coin of coins ) {
      coinbase_client.getSpotPrice({currencyPair: `${coin}-USD`}, function(err, price_data) {
        if( err ) {
          reject(err)
          return
        }
        prices[coin] = parseFloat(price_data.data.amount)
        if( coins.length == Object.keys(prices).length ) {
          resolve(prices)
        }
      })
    }
  })
}

let prices = {}

const get_new_prices = () => {
  return new Promise( (resolve, reject) => {
    get_spot_price(settings.coins)
    .then( (new_prices) => {
      prices = new_prices
      resolve(true)
    } )
  })
}

const price_timer = () => {
  get_new_prices()
  .catch( (error) => {
    console.error(error)
  })
  .then( () => {
    setTimeout( price_timer, settings.refresh_period*1000 )
  })
}

const get_total_value = () => {
  let total = 0
  return new Promise( (resolve, reject) => {
    gdax_private.getAccounts( (err, resp, data) => {
      data = _.filter(data, (acc) => {
        if( acc.currency === 'USD' ) return true
        return _.contains(settings.coins, acc.currency)
      })
      for( acc of data ) {
        if( acc.currency === 'USD' ) {
          total += parseFloat(acc.balance)
        } else {
          //  Get price of acc.currency
          if( !prices[acc.currency] ) {
            reject('No price data.')
            return
          }
          //  Convert to USD
          total += prices[acc.currency] * parseFloat(acc.balance)
        }
      }
      resolve(total)
    })
  })
}

const total_value_timer = () => {
  get_total_value()
  .then( (current_total) => {
    console.log(`${moment().format("MM/D/YY hh:mm:ss a")}\t$${current_total} USD`)
  } )
  .catch( (error) => {
    console.error(error)
  } )
  .then( () => {
    setTimeout( total_value_timer, settings.refresh_period*1000 )
  } )
}

total_value_timer()
price_timer()

const get_fills = (opts={}) => {
  return new Promise( (resolve, reject) => {
    gdax_private.getFills( opts, (error, response, data) => {
      if( error ) {
        reject(error)
        return
      }
      resolve(data)
    })
  })
}

const draw_chart = (data) => {
  let min = _.min( _.map(data, (d) => _.min(d.y)) )
  line = contrib.line({
    minY: min,
    xLabelPadding: 3,
    xPadding: 5,
    wholeNumbersOnly: false,
    label: 'Sell vs Buy'
  })
  screen.append(line)
  screen.key(['escape', 'q', 'C-c'], function(ch, key) {
    return process.exit(0);
  })
  line.setData(data)
  screen.render()
}

async function get_all_fills(product, pages=null) {
  let oldest_order = null
  let all_fills = []

  let page_count = 0
  function loop_condition() {
    if(pages) {
      if( page_count < pages ) return true
    } else {
      return true
    }
    return false
  }

  while( loop_condition() ) {
    console.log(`Getting page ${page_count+1}/${pages||'all'}`)
    let opts = {
      limit: 30,
      product_id: product
    }
    if( oldest_order ) opts.after = oldest_order
    try{
      let fills = await get_fills(opts)
      let num_fills = fills.length
      if( num_fills === 0 ) break
      all_fills = all_fills.concat(fills)
      oldest_order = fills[num_fills-1].trade_id
    } catch( error ) {
      console.error( error )
      if( error === "No data.") {
        break
      }
    }
    page_count++
  }

  return all_fills
}

const process_fills = ( fills ) => {
  fills.reverse() // oldest->newest
  let sells = _.where(fills, {side: 'sell'})
  let buys = _.where(fills, {side: 'buy'})

  //  Averages
  let sell_avg = _.reduce(sells, (total, fill) => {
    return total + parseFloat(fill.price)
  }, 0)
  let buy_avg = _.reduce(buys, (total, fill) => {
    return total + parseFloat(fill.price)
  }, 0)
  sell_avg /= sells.length
  buy_avg /= buys.length

  //  Totals
  let sell_total = _.reduce(sells, (total, fill) => {
    return total + (parseFloat(fill.price) * parseFloat(fill.size))
  }, 0)
  let buy_total = _.reduce(buys, (total, fill) => {
    return total + (parseFloat(fill.price) * parseFloat(fill.size))
  }, 0)

  console.log(`${fills[0].product_id} since ${moment(fills[0].created_at).format('ddd MMM Do, h:mm:ss a')}`)
  console.log(`Avg Buy:    $${buy_avg}`)
  console.log(`Avg Sell:   $${sell_avg}`)
  console.log(`Total Buy:  $${buy_total}`)
  console.log(`Total Sell: $${sell_total}`)
  console.log(`Net Delta:  $${sell_total-buy_total}`)
/*
  let chart_data = []
  const colors = {
    sell: 'red',
    buy: 'green'
  }
  for( dataset of [sells, buys] ) {
    let dataset_name = dataset[0].side
    let _data = {
      title: dataset_name,
      x: _.map(dataset, (d) => moment(d.created_at).format('M/D h:mm:ss a')),
      y: _.map(dataset, (d) => (parseFloat(d.price) * parseFloat(d.size))),
      style: {
        line: colors[dataset_name],
        text: colors[dataset_name],
        baseline: "black"
      }
    }
    chart_data.push(_data)
  }
  draw_chart(chart_data)
*/
}

/*
get_all_fills('BTC-USD', 10)
.then( (fills) => {
  process_fills(fills)
})
*/

const get_accounts = () => {
  return new Promise( (resolve, reject) => {
    gdax_private.getAccounts( (error, resp, data) => {
      if( error ) {
        reject( error )
        return
      }
      resolve( data )
    })
  })
}

const get_account_transfers = (account_id) => {
  return new Promise( (resolve, reject) => {
    console.log(account_id)
    gdax_private.getAccountHistory( account_id, {type: 'transfer'}, (error, response, data) => {
      if( error ) {
        reject( error )
        return
      }
      resolve( data )
    } )
  })
}

async function get_funding(coin) {
  let accounts = await get_accounts()
  let account = _.findWhere( accounts, {
    currency: coin
  } )

  let fundings = await get_account_transfers(account.id)
  console.log(fundings)
}

//get_funding('BTC')
