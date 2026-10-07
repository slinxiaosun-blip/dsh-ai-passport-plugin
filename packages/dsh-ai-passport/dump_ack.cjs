// 直接验证：设备发 msgId=N 的帧，我们回的 ACK 里 msgId 是不是 N
const { Reassembler, decodeHeader } = require('./lib/protocol/chunk.js')
