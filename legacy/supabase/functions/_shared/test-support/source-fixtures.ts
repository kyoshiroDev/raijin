// Real API responses captured on 2026-11-17 (trimmed to the fields the parsers read). Untrusted data.
// GeckoTerminal /networks/solana/trending_pools?page=1 and /networks/solana/pools?sort=h24_volume_usd_desc&page=1,
// Jupiter lite-api /tokens/v2/toptrending/1h, /toporganicscore/6h, /toptraded/1h (?limit=100),
// Jupiter lite-api /tokens/v2/search?query=<SOL>,<EURC>.
export const GECKO_TRENDING = {
  "data": [
    {
      "id": "solana_5AFbwVSQPJf4cgEjq4TajZYyPYUvYktrRN3SahNrPnmv",
      "type": "pool",
      "attributes": {
        "name": "GTA6 / SOL",
        "address": "5AFbwVSQPJf4cgEjq4TajZYyPYUvYktrRN3SahNrPnmv",
        "reserve_in_usd": "227424.943",
        "pool_created_at": "2026-10-29T13:56:21Z"
      },
      "relationships": {
        "base_token": {
          "data": {
            "id": "solana_4kjruqGHDsSqkMdFfCjV7Vb62HPFhtXyWc2t6JpQzDnz",
            "type": "token"
          }
        },
        "quote_token": {
          "data": {
            "id": "solana_So11111111111111111111111111111111111111112",
            "type": "token"
          }
        },
        "dex": {
          "data": {
            "id": "meteora",
            "type": "dex"
          }
        }
      }
    },
    {
      "id": "solana_6qz7THwQvcjF3HyDGLuKaLBUk6EyJKeZXZMWLAeiwfjd",
      "type": "pool",
      "attributes": {
        "name": "BP / USDC",
        "address": "6qz7THwQvcjF3HyDGLuKaLBUk6EyJKeZXZMWLAeiwfjd",
        "reserve_in_usd": "5911198.3698",
        "pool_created_at": "2026-03-23T12:39:55Z"
      },
      "relationships": {
        "base_token": {
          "data": {
            "id": "solana_BPxxfRCXkUVhig4HS1Lh7kZqV6SPJhzfEk4x6fVBjPCy",
            "type": "token"
          }
        },
        "quote_token": {
          "data": {
            "id": "solana_EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            "type": "token"
          }
        },
        "dex": {
          "data": {
            "id": "meteora",
            "type": "dex"
          }
        }
      }
    },
    {
      "id": "solana_Ho1aSG6WGH1FfXdEHrK2f4Ggt1Hoxo9s5jcLMDqeyeBz",
      "type": "pool",
      "attributes": {
        "name": "mihao / SOL",
        "address": "Ho1aSG6WGH1FfXdEHrK2f4Ggt1Hoxo9s5jcLMDqeyeBz",
        "reserve_in_usd": "360203.3152",
        "pool_created_at": "2026-10-25T16:43:15Z"
      },
      "relationships": {
        "base_token": {
          "data": {
            "id": "solana_4CxjZyMNoF1p6eXHXHv1TWpS2X47CuUmLwtGe18spump",
            "type": "token"
          }
        },
        "quote_token": {
          "data": {
            "id": "solana_So11111111111111111111111111111111111111112",
            "type": "token"
          }
        },
        "dex": {
          "data": {
            "id": "pumpswap",
            "type": "dex"
          }
        }
      }
    },
    {
      "id": "solana_7Te1wXcfeQjKLGHXFvxSCnGZTqunoZ9fxBn7KKjrkNEr",
      "type": "pool",
      "attributes": {
        "name": "DacityCoin / TTWO",
        "address": "7Te1wXcfeQjKLGHXFvxSCnGZTqunoZ9fxBn7KKjrkNEr",
        "reserve_in_usd": "372924.2715",
        "pool_created_at": "2026-10-15T13:27:11Z"
      },
      "relationships": {
        "base_token": {
          "data": {
            "id": "solana_DKYcjobF7HPtL9RyQBRdeRQ2iWvizpfbgWwPWNXdpump",
            "type": "token"
          }
        },
        "quote_token": {
          "data": {
            "id": "solana_TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo",
            "type": "token"
          }
        },
        "dex": {
          "data": {
            "id": "pumpswap",
            "type": "dex"
          }
        }
      }
    }
  ]
};

export const GECKO_VOLUME = {
  "data": [
    {
      "id": "solana_Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
      "type": "pool",
      "attributes": {
        "name": "SOL / USDC",
        "address": "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
        "reserve_in_usd": "17326775.3258",
        "pool_created_at": "2023-07-05T14:34:02Z"
      },
      "relationships": {
        "base_token": {
          "data": {
            "id": "solana_So11111111111111111111111111111111111111112",
            "type": "token"
          }
        },
        "quote_token": {
          "data": {
            "id": "solana_EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            "type": "token"
          }
        },
        "dex": {
          "data": {
            "id": "orca",
            "type": "dex"
          }
        }
      }
    },
    {
      "id": "solana_EXMcKF76kmBUH8xZ5fi1jv3ezh3eVQCeL4rQbpjCRxvF",
      "type": "pool",
      "attributes": {
        "name": "USDG / USDC",
        "address": "EXMcKF76kmBUH8xZ5fi1jv3ezh3eVQCeL4rQbpjCRxvF",
        "reserve_in_usd": null,
        "pool_created_at": "2026-04-17T18:01:59Z"
      },
      "relationships": {
        "base_token": {
          "data": {
            "id": "solana_2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH",
            "type": "token"
          }
        },
        "quote_token": {
          "data": {
            "id": "solana_EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            "type": "token"
          }
        },
        "dex": {
          "data": {
            "id": "manifest",
            "type": "dex"
          }
        }
      }
    },
    {
      "id": "solana_6WS9iYUuHBsPNUes6tnZSJNGXc5EqbirEqk1cutBG9p8",
      "type": "pool",
      "attributes": {
        "name": "ANT / SOL",
        "address": "6WS9iYUuHBsPNUes6tnZSJNGXc5EqbirEqk1cutBG9p8",
        "reserve_in_usd": "144255.3383",
        "pool_created_at": "2026-11-16T16:56:34Z"
      },
      "relationships": {
        "base_token": {
          "data": {
            "id": "solana_ELR9i6Z7uhtZMWqkySYNnDhviSuSMA7nnyZ1BocKkEK",
            "type": "token"
          }
        },
        "quote_token": {
          "data": {
            "id": "solana_So11111111111111111111111111111111111111112",
            "type": "token"
          }
        },
        "dex": {
          "data": {
            "id": "pumpswap",
            "type": "dex"
          }
        }
      }
    }
  ]
};

export const JUP_TRENDING_1H = [
  {
    "id": "TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo",
    "name": "Take-Two Interactive Software - Backpack Securities",
    "symbol": "TTWO",
    "mcap": 5232975.741330061,
    "liquidity": 2905824.523533584,
    "usdPrice": 205.83724954886475,
    "organicScore": 92.0786949845735,
    "tags": [
      "verified",
      "stocks",
      "rwa",
      "backpack",
      "token-2022"
    ],
    "createdAt": "2026-08-03T00:07:11Z"
  },
  {
    "id": "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",
    "name": "Orca",
    "symbol": "ORCA",
    "mcap": 71616499.95960717,
    "liquidity": 256911.27750445256,
    "usdPrice": 1.1779275649367846,
    "organicScore": 66.18775768045646,
    "tags": [
      "verified",
      "defi",
      "birdeye-trending",
      "community",
      "strict"
    ],
    "createdAt": "2024-06-07T10:45:14.408Z"
  },
  {
    "id": "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS",
    "name": "Zcash",
    "symbol": "ZEC",
    "mcap": 100664849.81565109,
    "liquidity": 4988694.457234366,
    "usdPrice": 923.274632884775,
    "organicScore": 96.03026380298616,
    "tags": [
      "verified",
      "moonshot-verified"
    ],
    "createdAt": "2025-10-10T20:31:03Z"
  }
];

export const JUP_ORGANIC_6H = [
  {
    "id": "So11111111111111111111111111111111111111112",
    "name": "Wrapped SOL",
    "symbol": "SOL",
    "mcap": 42886453947.370926,
    "liquidity": 779683890.6368552,
    "usdPrice": 72.69091408879775,
    "organicScore": 99.03084891961262,
    "tags": [
      "moonshot-verified",
      "strict",
      "verified",
      "major",
      "community"
    ],
    "createdAt": "2024-06-05T08:55:25.527Z"
  },
  {
    "id": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "name": "USD Coin",
    "symbol": "USDC",
    "mcap": 9177112686.867659,
    "liquidity": 366263473.9057508,
    "usdPrice": 0.9996041928736477,
    "organicScore": 100,
    "tags": [
      "community",
      "moonshot-verified",
      "strict",
      "verified",
      "stable"
    ],
    "createdAt": "2024-06-05T08:55:25.527Z"
  },
  {
    "id": "TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo",
    "name": "Take-Two Interactive Software - Backpack Securities",
    "symbol": "TTWO",
    "mcap": 5230261.748560578,
    "liquidity": 2905824.523533584,
    "usdPrice": 205.730495603389,
    "organicScore": 92.0786949845735,
    "tags": [
      "verified",
      "stocks",
      "rwa",
      "backpack",
      "token-2022"
    ],
    "createdAt": "2026-08-03T00:07:11Z"
  },
  {
    "id": "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump",
    "name": "The Black Bull",
    "symbol": "ANSEM",
    "mcap": 42201602.49116047,
    "liquidity": 1007651.8153400322,
    "usdPrice": 0.04231358173899534,
    "organicScore": 79.48333303961742,
    "tags": [
      "moonshot-verified",
      "meme",
      "token-2022",
      "verified"
    ],
    "createdAt": "2026-06-16T21:05:48Z"
  },
  {
    "id": "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v",
    "name": "Jupiter Staked SOL",
    "symbol": "JupSOL",
    "mcap": 373776789.7993781,
    "liquidity": 373776789.7993781,
    "usdPrice": 88.45485738547121,
    "organicScore": 87.46764280954449,
    "tags": [
      "strict",
      "verified",
      "community",
      "lst",
      "original-lst"
    ],
    "createdAt": "2024-06-07T10:30:07.011Z"
  }
];

export const JUP_TRADED_1H = [
  {
    "id": "oPNWKYTYJyEs2RbpjUXfCTxrNtiTjTcz3ipvUvBBAH2",
    "name": "OpenWorld - Backpack Securities",
    "symbol": "OPNW",
    "mcap": 99575.85850030567,
    "liquidity": 63058.53432503938,
    "usdPrice": 0.5675938853147312,
    "organicScore": 71.00477923678092,
    "tags": [
      "backpack",
      "token-2022",
      "verified",
      "stocks",
      "rwa"
    ],
    "createdAt": "2026-11-04T22:07:44Z"
  },
  {
    "id": "TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo",
    "name": "Take-Two Interactive Software - Backpack Securities",
    "symbol": "TTWO",
    "mcap": 5229970.202980411,
    "liquidity": 2905824.523533584,
    "usdPrice": 205.71902776113134,
    "organicScore": 92.0786949845735,
    "tags": [
      "backpack",
      "token-2022",
      "verified",
      "stocks",
      "rwa"
    ],
    "createdAt": "2026-08-03T00:07:11Z"
  },
  {
    "id": "ERiM8NiCanarGEnWMnURAoxTuTvUXZbtJsPTirnHpump",
    "name": "Official Grand Theft Auto VI",
    "symbol": "GTAVI",
    "mcap": 819075.0666206471,
    "liquidity": 136841.97939483085,
    "usdPrice": 0.0008362900477725928,
    "organicScore": 0,
    "tags": [
      "unknown",
      "token-2022"
    ],
    "createdAt": "2026-11-17T19:11:53Z"
  }
];

export const JUP_SOL_EURC_SEARCH = [
  {
    "id": "So11111111111111111111111111111111111111112",
    "name": "Wrapped SOL",
    "symbol": "SOL",
    "usdPrice": 72.70230692113226,
    "stats24h": {
      "priceChange": 2.39211330802799
    }
  },
  {
    "id": "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr",
    "name": "EURC",
    "symbol": "EURC",
    "usdPrice": 1.1003253453319297,
    "stats24h": {
      "priceChange": 0.04043806859334732
    }
  }
];

/**
 * Jupiter GET https://lite-api.jup.ag/tokens/v2/recent (checked 2026-11-21 12:27 UTC, 30 tokens, trimmed to 3; names
 * replaced): newest first pools (pump.fun launches 0–2 min old), tags ["unknown", "token-2022"], same record as
 * /tokens/v2/search.
 */
export const JUP_RECENT = [
  {
    "id": "2wedxHSrDxASDMGtPhboq5LubRvAx7GmzVrkRDpGpump",
    "name": "Recent token 1",
    "symbol": "RCT1",
    "decimals": 6,
    "tokenProgram": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    "firstPool": {
      "id": "2wedxHSrDxASDMGtPhboq5LubRvAx7GmzVrkRDpGpump",
      "createdAt": "2026-11-21T12:26:57Z"
    },
    "holderCount": 3,
    "audit": {
      "mintAuthorityDisabled": true,
      "freezeAuthorityDisabled": true,
      "devBalancePercentage": 4.08786134914715,
      "devMints": 357
    },
    "organicScore": 0,
    "organicScoreLabel": "low",
    "tags": [
      "unknown",
      "token-2022"
    ],
    "fdv": 5191.119631102109,
    "mcap": 2595.5598155510547,
    "usdPrice": 2.595559815551055e-06,
    "liquidity": 2545.2950383614702,
    "launchpad": "pump.fun",
    "createdAt": "2026-11-21T12:26:57Z"
  },
  {
    "id": "42MEFYyPUVqA87tTWiNNF2ptpAAerGa4vYkYfbKppump",
    "name": "Recent token 2",
    "symbol": "RCT2",
    "decimals": 6,
    "tokenProgram": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    "firstPool": {
      "id": "42MEFYyPUVqA87tTWiNNF2ptpAAerGa4vYkYfbKppump",
      "createdAt": "2026-11-21T12:26:54Z"
    },
    "holderCount": 3,
    "audit": {
      "mintAuthorityDisabled": true,
      "freezeAuthorityDisabled": true,
      "devBalancePercentage": 0.10423845618215001,
      "devMigrations": 2,
      "devMints": 224
    },
    "organicScore": 0,
    "organicScoreLabel": "low",
    "tags": [
      "unknown",
      "token-2022"
    ],
    "fdv": 4445.295806551117,
    "mcap": 2222.6479032755583,
    "usdPrice": 2.2226479032755584e-06,
    "liquidity": 2096.677412156162,
    "launchpad": "pump.fun",
    "createdAt": "2026-11-21T12:26:54Z"
  },
  {
    "id": "7h5f4TQV64EQJ2wHYPmemeNUeUGiCcCpALhtWD8wpump",
    "name": "Recent token 3",
    "symbol": "RCT3",
    "decimals": 6,
    "tokenProgram": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    "firstPool": {
      "id": "7h5f4TQV64EQJ2wHYPmemeNUeUGiCcCpALhtWD8wpump",
      "createdAt": "2026-11-21T12:26:48Z"
    },
    "holderCount": 3,
    "audit": {
      "mintAuthorityDisabled": true,
      "freezeAuthorityDisabled": true,
      "topHoldersPercentage": 50.1263354841028,
      "devMigrations": 21,
      "devMints": 155
    },
    "organicScore": 0,
    "organicScoreLabel": "low",
    "tags": [
      "unknown",
      "token-2022"
    ],
    "fdv": 4466.982014435888,
    "mcap": 2233.491007217944,
    "usdPrice": 2.233491007217944e-06,
    "liquidity": 2052.9307370085808,
    "launchpad": "pump.fun",
    "createdAt": "2026-11-21T12:26:48Z"
  }
];
