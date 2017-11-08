# gdax-multipong
This is a tradebot for BTC, ETH and LTC written in NodeJS for GDAX.  It is designed for flat or oscillating markets.

You will need
*  GDAX API key ([official instructions for creating](https://support.gdax.com/customer/en/portal/articles/2425383-how-can-i-create-an-api-key-for-gdax-)) with **trade** and **view** permissions
*  NodeJS v7.8 or greater (if you're not managing your node installs using [nvm](https://github.com/creationix/nvm) you're missing out!)

## Setup
1.  `npm install`
1.  Put your GDAX API `passphrase`, `key`, and `secret` into `settings.json`
1.  Set your currency and buckets in `settings.json` (more below)
1.  `node multipong.js`

To begin buying and selling, press the "b" and "s" keys.

## Commands
*  `c` - Cancel all pending buys.  Note, if buying is "on", these orders will be almost instantly-replaced.  Turn off buying before canceling any orders!
*  `b` - Toggle buying on and off
*  `s` - Toggle selling on and off
*  `q`, `ESC`, or `CTRL+C` - Exit Multipong

## Strategy
Multipong uses a bucket strategy to perform high-frequency range trading between a minimum and maximum currency price in many smaller sub-ranges.

Here's an example with Ethereum.  In this example, buckets are a little less than $0.10USD wide.  Multipong will place a few buy orders, always less than the current mid-market price.  Each buy order is one bucket-width apart.  As soon as one of these buy orders is filled, Multipong will automatically place a sell order one bucket-width higher.  Thus every filled buy will yield exactly one sell, and always at a profit:

![](multipong-eth-1.PNG)

As the price of Ethereum falls, more buy orders are placed and filled.  As the price bounces back up, the sell orders are filled, yielding a profit; and the buys are then re-placed.

![](multipong-eth-2.PNG)

As the price of a cryptocurrency oscillates throughout the day, many small profitable buy/sell pairs will be executed.  Especially for oscillating markets, this can produce hundreds or thousands of trades a day, all of them favorable.

Each trade will be `trade_size` big; in the images above, the `trade_size` was 0.1ETH.  Clearly, deeper trade sizes will yield more profit per trade, but will drain your fiat capital faster as each trade is more expensive.

Wider buckets can yield a larger profit per trade as well, as the buy-sell spread is larger, but, the price would have to vary much more to make each trade happen, and are only good for more volatile market conditions.  This approach can also be useful if the price is varying a great deal during the day, and you don't want to spend all your fiat in a small price range.

The bucket strategy is helpful in case the currency price falls after buying some crypto.  Say the price of BTC is 5995USD and we buy 0.01BTC; while we wait for the price to hit 6000USD and make a sale, what if the price falls again?  Since each bucket can only buy once, we are guaranteed to still have buckets at *lower* prices that will continue to trade, making money, while our earlier gamble is waiting to be realized.  This allows us to keep making money across a wide price range instead of putting all our eggs into one basket.

Multipong performs best with thin (price width), deep (trade size) buckets, and works best in mostly-flat or oscillating markets.  Note, you may win or lose.  Multipong is provided "as-is," with no guarantees or promises!  Multipong should never place an unfavorable trade, but it could place a favorable trade that never happens.  As with all things crypto, be safe!

## Configuration
Here's an example `settings.json`:
```json
{
  "gdax": {
    "api": {
      "key": "",
      "secret": "",
      "passphrase": "",
      "uri": "https://api.gdax.com"
    }
  },
  "tz": "America/New_York",
  "multipong": {
    "coin": "ETH",
    "fiat": "USD",
    "initial_cash": 380.13,
    "greedy": false,
    "num_buckets": 100,
    "trade_size": 0.1,
    "min_price": 295,
    "max_price": 302,
    "midmarket_price_period": 1,
    "trade_period": 50,
  }
}
```

GDAX API settings are self-explanatory.  Make sure you have **trade** and **view** permissions!

Here's what the `multipong` configuration parameters mean:

*  Multipong will trade between `fiat` currency for `coin`; in this example, it will buy and sell ETH with USD.  Available options are only what GDAX provides (BTC, ETH, LTC, USD, GBP, EUR).
*  `trade_size` is the quantity of `coin` that the bot will buy or sell per bucket.  Keep in mind GDAX's minimums: 0.01 for BTC.
*  Buy and sell BTC if it's between `min_price` and `max_price`.  Trading will stop if the price goes above `max_price` or below `min_price`.
*  `num_buckets` is how many mini-trades the min-max price range will be subdivided into.  A higher number here means more frequent trades, but less profitable ones.  It also increases liability for fees if the market has sudden shifts.  If buckets are only a few cents or dollars, a quickly shifting price can crash through many buckets at once, and some orders might end up being taker orders!
*  `initial_cash` is the cash amount you want to use for bookkeeping in the app.  (If `greedy: false`, Multipong will not spend more than this amount of cash.)
*  `greedy` determines whether or not `initial_cash` will be treated as your total fiat capital.  If `greedy: true`, Multipong will make buys as long as your fiat wallet has enough funds, even if those funds are more than `initial_cash`.  Conversely, if `greedy: false`, Multipong will stop placing buys when it has exhausted `initial_cash`, even if there are more funds in your fiat wallet.
*  `midmarket_price_period` how many ms between updating the current crypto midmarket price in the app
*  `trade_period` how many ms between placing new trades

You are encouraged to explore various permutations of `min_price`, `max_price`, `trade_size` and `num_buckets`.  To avoid getting stuck out with high buys during large runs, we advise you to set a `max_price` below the expected maximum for a given trading period.  You want `min_price` and `max_price` to wrap around the range where the price is expected to see the most volume of trading!

## Updating Buckets/Resetting
Multipong will save all trade history and bucket distribution into a local database file, named like `BTC-USD.db` or `ETH-USD.db` etc. on boot.  If you change `settings.json` and restart, some settings won't have any effect, as this DB will be read from disk instead.

To reset Multipong entirely, just delete this file, update `settings.json` as you like, and re-run the app.  Note that this may orphan buy or sell orders on GDAX if you stopped while orders are pending; you will have to manage those manually.

If you want to update your bucket distribution (min/max/trade size/buckets), but retain your trade history, wait for all sells to complete, and then quit the app.  Manually cancel all buy orders in GDAX.  Then, update your `settings.json`.  Finally, run `node clearbuckets.js btc` (or other currency).  Then, just run the app again!  This will make a new bucket trading distribution in the DB, but leave all your old trade and profit history untouched.

This software is provided free for your amusement, edification, and enrichment!  However, if you enjoy multipong, you can show your appreciation by sending a BTC tip to the author here at `1Nhdd9UCsv9dsabLLNRue8ecDN41yrSRdk`
