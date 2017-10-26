fs = require("fs")
settings = JSON.parse( fs.readFileSync("settings.json", "utf8") )
const gdax = require('gdax')
const _ = require('underscore')
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

/*
const gdax_ws = new gdax.WebsocketClient(['BTC-USD'])
gdax_ws.on('message', (data) => {
  console.log(data)
})
*/

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
    console.log(`$${current_total} USD`)
  } )
  .catch( (error) => {
    console.error(error)
  } )
  .then( () => {
    setTimeout( total_value_timer, settings.refresh_period*1000 )
  } )
}

//total_value_timer()
//price_timer()

let cumulative_change = 0

let sells = 0
let buys = 0
let sale_sum = 0
let buy_sum = 0

const get_fills = (product, opts={}) => {
  sells = 0
  buys = 0
  sale_sum = 0
  buy_sum = 0
  return new Promise( (resolve, reject) => {
    opts.product_id = product
    gdax_private.getFills( opts, (error, response, data) => {
      if( error ) {
        reject(error)
        return
      }
      if( !data.length ) {
        reject('No data.')
        return
      }
      let oldest_order, oldest_date
      let first_order = data[0].trade_id
      for( let fill of data ) {
        oldest_order = fill.trade_id
        oldest_date = fill.created_at
        let price = parseFloat(fill.price)
        let size = parseFloat(fill.size)
        let delta = price * size
        let change = ''
        switch( fill.side ) {
          case 'buy':
            cumulative_change -= delta
            buy_sum += price
            buys++
            change = '-'
            break
          case 'sell':
            cumulative_change += delta
            sale_sum += price
            sells++
            change = '+'
            break
        }
        //console.log(`$${cumulative_change}\t${change}$${delta}`)
      }
      resolve({
        first_order: first_order,
        oldest_order: oldest_order,
        oldest_date: oldest_date
      })
    })
  })
}

const draw_chart = (data) => {
  data = _.map(data, (d) => {
    let _d = d
    _d.x = d.x.reverse()
    _d.y = d.y.reverse()
    return _d
  })
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

async function get_all_fills(product, pages=1) {
  let page_count = 0
  let oldest_order = null

  let sell_data = {
    title: 'Sell',
    x: [],
    y: [],
    style: {
      line: "red",
      text: "red",
      baseline: "black"
    }
  }
  let buy_data = {
    title: 'Buy',
    x: [],
    y: [],
    style: {
      line: "green",
      text: "green",
      baseline: "black"
    }
  }
  let difference_data = {
    title: 'Difference',
    x: [],
    y: [],
    style: {
      line: "grey",
      text: "grey",
      baseline: "black"
    }
  }

  while( page_count < pages ) {
    let opts = {
      limit: 30
    }
    if( oldest_order ) {
      opts = {
        after: oldest_order
      }
    }
    try{
      let pagination_data = await get_fills(product, opts)
      let ts = new Date(pagination_data.oldest_date).valueOf()
      oldest_order = pagination_data.oldest_order
      let sell_avg = sale_sum/sells
      let buy_avg = buy_sum/buys
      console.log(`[${page_count}/${pages}] S $${sell_avg}\tB $${buy_avg} -/+ ${sell_avg-buy_avg} (${pagination_data.oldest_date})`)
      sell_data.x.push(ts)
      sell_data.y.push(sell_avg)
      buy_data.x.push(ts)
      buy_data.y.push(buy_avg)
      //difference_data.x.push(ts)
      //difference_data.y.push((sell_avg-buy_avg))
    } catch( error ) {
      console.error( error )
      if( error === "No data.") {
        break
      }
    }
    page_count++
  }

  //draw_chart([sell_data, buy_data])
}

get_all_fills('ETH-USD', 30)
