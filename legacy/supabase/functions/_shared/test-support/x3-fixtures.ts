// Real API responses recorded on 2026-11-17 (trimmed, public data only, no secret).
// Test-only: imported by gecko_history_test.ts and market_context_test.ts. Treat as untrusted input.

/** GET api.geckoterminal.com/api/v2/networks/solana/pools/B8a1…1jqv/ohlcv/minute?aggregate=15&limit=3&token=D9Ec…pump */
export const GECKO_OHLCV_15M = {
  "data": {
    "id": "03a6c453-fd41-40de-82e4-5237d0eacd90",
    "type": "ohlcv_request_response",
    "attributes": {
      "ohlcv_list": [
        [1794892500, 0.0011665447160803613, 0.0012929758626744744, 0.0011402871463999133, 0.0012617847812096059, 11125.145463674155],
        [1794891600, 0.0010594730800565057, 0.001194094835217157, 0.001020024875164468, 0.0011665447160803613, 15255.890698055968],
        [1794890700, 0.0010549085649663244, 0.00112273329527967, 0.0009695715309882081, 0.0010594730800565057, 20121.48653532181]
      ]
    }
  },
  "meta": {
    "base": { "name": "Vice City Bawsaq", "symbol": "BAWSAQ", "coingecko_coin_id": null, "address": "D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump" },
    "quote": { "name": "Wrapped SOL", "symbol": "SOL", "coingecko_coin_id": "wrapped-solana", "address": "So11111111111111111111111111111111111111112" }
  }
} as const;

/** Same pool, hourly, before_timestamp=1794892500, limit=2. */
export const GECKO_OHLCV_1H_BEFORE = {
  "data": {
    "id": "741a1876-8d9a-4a4d-abac-14de606d5467",
    "type": "ohlcv_request_response",
    "attributes": {
      "ohlcv_list": [
        [1794888000, 0.0015681147208917705, 0.0015681147208917705, 0.0009695715309882081, 0.0010594730800565057, 85816.91813009839],
        [1794884400, 0.0017736173605679883, 0.002549999799184557, 0.0014794875332222164, 0.0015681147208917705, 157606.56441316666]
      ]
    }
  }
} as const;

/** Unknown pool → HTTP 404. */
export const GECKO_404 = { "errors": [{ "status": "404", "title": "Not Found" }], "meta": { "ref_id": "2e3adf10-8c78-47d8-b845-41acbe157094" } } as const;

/** GET lite-api.jup.ag/tokens/v2/search?query=So11111111111111111111111111111111111111112 (trimmed). */
export const JUP_SOL_SEARCH = [
  {
    "id": "So11111111111111111111111111111111111111112",
    "symbol": "SOL",
    "usdPrice": 72.98814859804563,
    "stats24h": {
      "priceChange": 1.7260230790427402,
      "liquidityChange": 0.28137149066603584,
      "volumeChange": 0.8167551542750718,
      "numBuys": 12145184,
      "numSells": 17029044
    }
  }
] as const;
