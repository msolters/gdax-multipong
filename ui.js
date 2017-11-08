const blessed = require('blessed')
const contrib = require('blessed-contrib')
const DEBUG = false

exports = module.exports = {}

let screen
const ui = {}

const init = exports.init = () => {
  if( DEBUG ) return
  init_screen()
  init_keystrokes()
}

const init_screen = exports.init_screen = () => {
  screen = blessed.screen()
  ui.overview_table = contrib.table({
    top: '2%',
    left: '2%',
    width: '96%',
    height: '13%',
    label: 'Overview',
    border: {type: 'line', fg: 'yellow'},
    fg: 'yellow',
    interactive: false,
    columnSpacing: 4,               //in chars
    columnWidth: [12, 8, 12, 12, 8, 12, 12, 12, 12, 8, 8, 8],  // in chars
  })
  ui.trade_table = contrib.table({
    keys: true,
    fg: 'yellow',
    interactive: false,
    label: 'Trade Buckets',
    width: '48%',
    height: '82%',
    top: '16%',
    left: '50%',
    border: {type: "line", fg: "yellow"},
    columnSpacing: 4, //in chars
    columnWidth: [4, 12, 12, 4, 17], /*in chars*/
  })
  ui.trade_log = contrib.log({
    fg: "yellow",
    selectedFg: "yellow",
    label: 'Trade Log',
    left: '2%',
    top: '16%',
    width: '46%',
    height: '28%',
    border: {type: "line", fg: "yellow"}
  })
  ui.sys_log = contrib.log({
    fg: "yellow",
    selectedFg: "yellow",
    label: 'System Log',
    left: '2%',
    top: '47%',
    width: '46%',
    height: '51%',
    border: {type: "line", fg: "yellow"}
  })

  screen.append(ui.overview_table)
  screen.append(ui.trade_table)
  screen.append(ui.trade_log)
  screen.append(ui.sys_log)

  setInterval( () => {
    refresh_overview_table()
    refresh_trade_table()
    screen.render()
  }, 300 )
}

const init_keystrokes = exports.init_keystrokes = () => {
  screen.key(['escape', 'q', 'C-c'], (ch, key) => {
    exit_gracefully()
  })
  // toggle buys
  screen.key(['b'], (ch, key) => {
    trade_data.buys.enabled = !trade_data.buys.enabled
    if( trade_data.buys.enabled ) {
      logger('sys_log', 'Buying is now enabled.')
    } else {
      logger('sys_log', 'Buying is now disabled.')
    }
  })
  // toggle sells
  screen.key(['s'], (ch, key) => {
    trade_data.sells.enabled = !trade_data.sells.enabled
    if( trade_data.sells.enabled ) {
      logger('sys_log', 'Selling is now enabled.')
    } else {
      logger('sys_log', 'Selling is now disabled.')
    }
  })
  // cancel buys
  screen.key(['c'], (ch, key) => {
    trades.cancel_all_buys()
  })
  // Reinitialize the app
  screen.key(['r'], (ch, key) => {
    reload_config()
  })
}

const refresh_trade_table = exports.refresh_trade_table = () => {
  let table_data = []
  for( let trade of _.sortBy(_.values(trades.trades), (t) => -t.buy.price) ) {
    let buy_price = (trade.buy.price) ? `$${trade.buy.price.toFixed(2)}` : '-'
    let sell_price = (trade.sell.executed_price) ? `$${trade.sell.executed_price.toFixed(2)}` : '-'
    let row = [trade.side, buy_price, sell_price, trade.size, trade.state]
    table_data.push( row )
  }

  ui.trade_table.setData({
    headers: ['Side', 'Buy @', 'Sell @', 'Size', 'State'],
    data: table_data
  })
}

const refresh_overview_table = exports.refresh_overview_table = () => {
  if( !account.account || !settings ) return
  let current_price = 'Loading'
  if( gdax.orderbook_synced ) current_price = `$${gdax.midmarket_price.current.toFixed(3)}`
  ui.overview_table.setData({
    headers: [`P (${(settings) ? settings.product_id : '-'})`, 'dP/dt', 'Initial Cash', 'Cash on Hand', 'Fees', 'Profit', 'Net Gain', 'Max Gain', 'Buys', 'Sells', 'Min', 'Max'],
    data: [[  current_price,
              `$${gdax.midmarket_price.velocity.toPrecision(4)}/s`,
              `$${(settings) ? settings.multipong.initial_cash.toFixed(2) : '-'}`,
              `$${trades.figures.current_cash.toFixed(2)}`,
              `$${account.account.fees.toFixed(2)}`,      // fees
              `$${trades.figures.profit.toFixed(2)}`,    // profit
              `$${trades.figures.net_gain.toPrecision(4)}`,              // net
              `$${trades.figures.max_profit.toPrecision(4)}`, // max
              `${(trade_data.buys.enabled ? 'On' : 'Off')} (${account.account.buy_count})`,
              `${(trade_data.sells.enabled ? 'On' : 'Off')} (${account.account.sell_count})`,
              `$${(settings) ? settings.multipong.min_price.toFixed(2) : '-'}`,
              `$${(settings) ? settings.multipong.max_price.toFixed(2) : '-'}`]]
  })
}

const logger = exports.logger = (target, content) => {
  if( typeof content !== 'string' ) {
    content = JSON.stringify(content)
  }
  if( log.file ) {
    log.file.write( content )
    log.file.write('\n')
  }
  if( DEBUG ) {
    console.log(content)
    return
  }
  ui[target].log(`${moment().tz(settings.tz).format('HH:mm:ss')} ${content}`)
}
