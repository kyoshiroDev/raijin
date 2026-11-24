// Real API responses recorded on 2026-11-16 (trimmed, public data only, no secret).
// Test-only: imported by enrich_test.ts. Treat as untrusted input.

export const JUP_BUY = {
  "inputMint": "So11111111111111111111111111111111111111112",
  "inAmount": "100000000",
  "outputMint": "D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump",
  "outAmount": "4289987600",
  "otherAmountThreshold": "4161287972",
  "swapMode": "ExactIn",
  "slippageBps": 300,
  "platformFee": null,
  "priceImpactPct": "0.0069193663175585659568886668",
  "routePlan": [
    {
      "swapInfo": {
        "ammKey": "B8a1mw1vfm5pnm4RgUd8zhbtBnkPB2fBMdikU33Z1jqv",
        "label": "Pump.fun Amm",
        "inputMint": "So11111111111111111111111111111111111111112",
        "outputMint": "D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump",
        "inAmount": "100000000",
        "outAmount": "4289987600",
        "updateContextSlot": "470293988"
      },
      "percent": 100,
      "bps": null
    }
  ],
  "contextSlot": 470293991,
  "timeTaken": 0.000117856,
  "swapUsdValue": "7.202082188320230"
} as const;

export const JUP_SELL = {
  "inputMint": "D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump",
  "inAmount": "4289987600",
  "outputMint": "So11111111111111111111111111111111111111112",
  "outAmount": "98242777",
  "otherAmountThreshold": "95295494",
  "swapMode": "ExactIn",
  "slippageBps": 300,
  "platformFee": null,
  "priceImpactPct": "0.0101652974913344649782520062",
  "routePlan": [
    {
      "swapInfo": {
        "ammKey": "B8a1mw1vfm5pnm4RgUd8zhbtBnkPB2fBMdikU33Z1jqv",
        "label": "Pump.fun Amm",
        "inputMint": "D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump",
        "outputMint": "So11111111111111111111111111111111111111112",
        "inAmount": "4289987600",
        "outAmount": "98242777",
        "updateContextSlot": "470294092"
      },
      "percent": 100,
      "bps": null
    }
  ],
  "contextSlot": 470294092,
  "timeTaken": 0.000125611,
  "swapUsdValue": "7.0793769894273522383751"
} as const;

export const JUP_NOT_TRADABLE = {
  "error": "The token 11111111111111111111111111111112 is not tradable",
  "errorCode": "TOKEN_NOT_TRADABLE"
} as const;

export const RUG_DANGER = {
  "tokenProgram": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "tokenType": "",
  "risks": [
    {
      "name": "Creator history of rugged tokens",
      "value": "",
      "description": "Creator has a history of rugging tokens.",
      "score": 33600,
      "level": "danger"
    }
  ],
  "score": 33601,
  "score_normalised": 67,
  "lpLockedPct": 100
} as const;

export const RUG_CLEAN = {
  "tokenProgram": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "tokenType": "",
  "risks": [],
  "score": 1,
  "score_normalised": 1,
  "lpLockedPct": 99.99710960920915
} as const;

export const RUG_WARN = {
  "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "tokenType": "",
  "risks": [
    {
      "name": "Mutable metadata",
      "value": "",
      "description": "Token metadata can be changed by the owner",
      "score": 100,
      "level": "warn"
    }
  ],
  "score": 101,
  "score_normalised": 7,
  "lpLockedPct": 19.417023046938112
} as const;

export const RUG_INVALID_MINT = {
  "error": "invalid token mint"
} as const;

export const GECKO_MULTI = {
  "data": [
    {
      "id": "solana_B8a1mw1vfm5pnm4RgUd8zhbtBnkPB2fBMdikU33Z1jqv",
      "type": "pool",
      "attributes": {
        "base_token_price_usd": "0.00165212898007729157245796335016458050791595902755185497865219045",
        "quote_token_price_usd": "72.147342679732898436815000237631751340389399973",
        "address": "B8a1mw1vfm5pnm4RgUd8zhbtBnkPB2fBMdikU33Z1jqv",
        "name": "BAWSAQ / SOL",
        "reserve_in_usd": "95340.4401",
        "locked_liquidity_percentage": "100.0"
      },
      "relationships": {
        "base_token": {
          "data": {
            "id": "solana_D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump",
            "type": "token"
          }
        },
        "quote_token": {
          "data": {
            "id": "solana_So11111111111111111111111111111111111111112",
            "type": "token"
          }
        }
      }
    },
    {
      "id": "solana_5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9",
      "type": "pool",
      "attributes": {
        "base_token_price_usd": "0.00000235107340613195587044855784855948038822631104",
        "quote_token_price_usd": "71.879891571688393651786749984",
        "address": "5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9",
        "name": "Bonk / SOL",
        "reserve_in_usd": "231446.9161",
        "locked_liquidity_percentage": "0.0"
      },
      "relationships": {
        "base_token": {
          "data": {
            "id": "solana_DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
            "type": "token"
          }
        },
        "quote_token": {
          "data": {
            "id": "solana_So11111111111111111111111111111111111111112",
            "type": "token"
          }
        }
      }
    }
  ]
} as const;

export const JUP_SEARCH_USDPRICE = [
  {
    "id": "D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump",
    "usdPrice": 0.0018141054159705058,
    "liquidity": 49063.01829306509
  },
  {
    "id": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    "usdPrice": 0.0000023564273636898163,
    "liquidity": 5704862.6731624
  }
] as const;


// RugCheck FULL report `GET /v1/tokens/{mint}/report`, recorded on 2026-11-17 (trimmed to the fields we read plus
// a few neighbours; the real bodies are 9–95 KB). Insider graph only exists here, not in the summary.
export const RUG_REPORT_INSIDERS = {
  "mint": "2Ho2MGgveuwjGoEa9cTMKxjQxpmupxixDNdQaw3Upump",
  "creatorTokens": null,
  "graphInsidersDetected": 25,
  "insiderNetworks": [
    { "id": "lively-quartz-okapi", "size": 9, "type": "transfer", "tokenAmount": 52142444298384, "currentHolding": 52142444298384, "activeAccounts": 9 }
  ],
  "risks": [],
  "score": 1,
  "score_normalised": 1,
  "rugged": false
} as const;

export const RUG_REPORT_CLEAN = {
  "mint": "8n3Unw7Ujbcj13RMD7HkESrwYQduFrCRNSLoBg2Spump",
  "graphInsidersDetected": 0,
  "insiderNetworks": null,
  "risks": [],
  "score": 1,
  "score_normalised": 1,
  "rugged": false
} as const;
