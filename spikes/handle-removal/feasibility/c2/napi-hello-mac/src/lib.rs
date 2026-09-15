use napi_derive::napi;
#[napi]
pub fn hello() -> u32 { 42 }
