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

You can quit at any time by pressing `Q`, `CTRL+C` or `ESC`.  Multipong will resync trades when it starts up next.

## Strategy
Multipong uses a bucket strategy to perform high-frequency range trading between a minimum and maximum currency price in many smaller sub-ranges.  So for example, you can trade BTC between 5500USD and 6000USD using 100 buckets, and a trade size of 0.01BTC.

In this example, the bot would buy 0.01BTC each time the price fell to `[5500, 5505, 5510, 5515, ...]`USD; if any of these buys is filled, the bot would then automatically place a sell order at `[5505, 5510, 5515, 5520, ...]`.  In other words, anytime the price changes one bucket width (`(max_price-min_price)/num_buckets = (6000-5500)/100 = 5USD`), the bot will automatically place a trade at the low and high end of each bucket.

The price might bounce between e.g. 5510 and 5515 for a few minutes; during this time, the bot can automatically make the same trade over and over; although 0.01BTC bought and sold with a $5 difference only yields $0.05 profit, multipong can do this thousands of times a day.

Clearly, deeper buckets can yield a larger profit per trade, but, the price would have to vary much more to make each trade happen, and are only good for highly volatile market conditions.  Likewise, buying/selling more BTC per bucket can increase profitability as well.

The bucket strategy is helpful in case the currency price falls after buying some BTC.  Say the price is 5995USD and we buy 0.01BTC; while we wait for the price to hit 6000USD and make a sale, what if the price falls?  Since each bucket can only buy once, we are guaranteed to still have buckets at lower prices that will continue to trade, making money, while our earlier gamble is waiting to be realized.  This allows us to keep making money across a wide price range instead of putting all our eggs into one basket.

Multipong performs best with thin, deep buckets, and works best in mostly-flat or oscillating markets.  Note, you may win or lose.  Multipong is provided "as-is," with no guarantees or promises!  Multipong should never place an unfavorable trade, but it could place a favorable trade that never happens.  As with all things crypto, be safe!

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
  "tz": "EST",
  "multipong": {
    "coin": "BTC",
    "fiat": "USD",
    "initial_cash": 726.64,
    "num_buckets": 300,
    "trade_size": 0.02,
    "min_price": 6000,
    "max_price": 6750,
    "midmarket_price_period": 1,
    "trade_period": 50,
    "DEBUG": false
  }
}
```

GDAX API settings are self-explanatory.  Make sure you have **trade** and **view** permissions!

Here's what the `multipong` configuration parameters mean:

*  Multipong will trade between `fiat` currency for `coin`; in this example, it will buy and sell BTC with USD.  Available options are only what GDAX provides (BTC, ETH, LTC, USD, GBP, EUR).
*  `trade_size` is the quantity of `coin` that the bot will buy or sell at per bucket.  Keep in mind GDAX's minimums: 0.01 for BTC.
*  Buy and sell BTC if it's between `min_price` and `max_price`.  Trading will stop if the price goes above `max_price` or below `min_price`.
*  `num_buckets` is how many mini-trades the min-max price range will be subdivided into.  A higher number here means more frequent trades, but less profitable ones.  It also increases liability for fees if the market has sudden shifts.  If buckets are only a few cents or dollars, a quickly shifting price can crash through many buckets at once, and some orders might end up being taker orders!
*  Initial cash is the cash amount you want to use for bookkeeping.  (IMPORTANT NOTE: As of this writing, multipong will not stop at this quantity and will use all the money in your GDAX fiat wallet if it can; `initial_cash` is only used for bookkeeping purposes. A future version will allow an option for greedy/non-greedy mode)
*  `midmarket_price_period` how many ms between updating the current coin price in the app
*  `trade_period` how many ms between placing new trades

You are encouraged to explore various permutations of `min_price`, `max_price`, `trade_size` and `num_buckets`.  To avoid getting stuck out with high buys during large runs, we advise you to set a `max_price` below the expected maximum for a given trading period.  You want `min_price` and `max_price` to wrap around the range where the price is expected to see the most volume of trading!

## Updating Buckets/Resetting
Multipong will save all trade history and bucket distribution into a local database file, named like `BTC-USD.db` or `ETH-USD.db` etc. on boot.  If you change `settings.json` and restart, some settings won't have any effect, as this DB will be read from disk instead.

To reset Multipong entirely, just delete this file, update `settings.json` as you like, and re-run the app.  Note that this may orphan buy or sell orders on GDAX if you stopped while orders are pending; you will have to manage those manually.

If you want to update your bucket distribution (min/max/trade size/buckets), but retain your trade history, wait for all sells to complete, and then quit the app.  Manually cancel all buy orders in GDAX.  Then, update your `settings.json`.  Finally, run `node clearbuckets.js btc` (or other currency).  Then, just run the app again!  This will make a new bucket trading distribution in the DB, but leave all your old trade and profit history untouched.

This software is provided free for your amusement, edification, and enrichment!  However, if you enjoy multipong, you can show your appreciation by sending a BTC tip to the author here at `1Nhdd9UCsv9dsabLLNRue8ecDN41yrSRdk`
