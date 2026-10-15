{
  "targets": [
    {
      "target_name": "shim",
      "sources": ["src/shim.c"],
      "defines": ["NAPI_VERSION=8"],
      "conditions": [
        ["OS=='linux'", { "defines": ["_GNU_SOURCE"] }]
      ]
    }
  ]
}
