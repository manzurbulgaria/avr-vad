const sinon = require("sinon")
const vad = require("../dist")
const { assert } = require("chai")

/**
 * @param {vad.FrameProcessorOptions} overrides
 */
function getOptions(overrides) {
  /**
   * @type {vad.FrameProcessorOptions}
   */
  const options = {
    frameSamples: 1536,
    positiveSpeechThreshold: 0.6,
    negativeSpeechThreshold: 0.4,
    redemptionFrames: 4,
    preSpeechPadFrames: 5,
    minSpeechFrames: 6,
    ...overrides,
  }
  let modelFunc = sinon.stub()
  modelFunc.callsFake(async () => modelFunc.returnValue)
  returnSpeech(modelFunc, options.positiveSpeechThreshold)
  return { modelFunc, resetFunc: sinon.stub(), options }
}

function returnNotSpeech(modelFunc, negativeThreshold) {
  const isSpeech = negativeThreshold / 2
  modelFunc.returnValue = { isSpeech, notSpeech: 1 - isSpeech }
}

function returnSpeech(modelFunc, positiveThreshold) {
  const isSpeech = positiveThreshold + (1 - positiveThreshold) / 2
  modelFunc.returnValue = { isSpeech, notSpeech: 1 - isSpeech }
}

function assertArrayEqual(arrX, arrY) {
  for (let i = 0; i <= Math.max(arrY.length - 1, arrX.length - 1); i++) {
    assert.strictEqual(arrY[i], arrX[i], `arrX ${arrX} != arrY ${arrY}`)
  }
}

function ints1To(end) {
  let out = []
  for (let i = 1; i <= end; i++) {
    out.push(i)
  }
  return out
}

describe("frame processor algorithm", function () {
  it("prepend `preSpeechPadFrames` of audio", async function () {
    let msg, audio

    let { modelFunc, resetFunc, options } = getOptions()
    returnNotSpeech(modelFunc, options.negativeSpeechThreshold)
    const frameProcessor = new vad.FrameProcessor(modelFunc, resetFunc, options)
    frameProcessor.resume()
    for (let i = 1; i <= options.preSpeechPadFrames; i++) {
      await frameProcessor.process(new Float32Array([i]), (event) => {msg = null; audio = null})
      assert.isNotOk(msg)
      assert.isNotOk(audio)
    }
    returnSpeech(modelFunc, options.positiveSpeechThreshold)
    await frameProcessor.process(new Float32Array([1]), (event) => {msg = event.msg; audio = event.audio})

    assert.strictEqual(msg, vad.Message.SpeechStart)
    assert.isNotOk(audio)
    for (let i = 2; i <= options.minSpeechFrames; i++) {
      await frameProcessor.process(new Float32Array([i]), (event) => {msg = null; audio = null})
      assert.isNotOk(msg)
      assert.isNotOk(audio)
    }
    returnNotSpeech(modelFunc, options.negativeSpeechThreshold)
    for (i = 1; i <= options.redemptionFrames - 1; i++) {
      await frameProcessor.process(new Float32Array([i]), (event) => {msg = null; audio = null})
      assert.isNotOk(msg)
      assert.isNotOk(audio)
    }
    await frameProcessor.process(
      new Float32Array([options.redemptionFrames]),
      (event) => {msg = event.msg; audio = event.audio}
    )
    assert.strictEqual(msg, vad.Message.SpeechEnd)
    assertArrayEqual(
      audio,
      new Float32Array([
        ...ints1To(options.preSpeechPadFrames),
        ...ints1To(options.minSpeechFrames),
        ...ints1To(options.redemptionFrames),
      ])
    )
  })

  it("messages.SpeechStart sent", async function () {
    let { modelFunc, resetFunc, options } = getOptions()
    const frameProcessor = new vad.FrameProcessor(modelFunc, resetFunc, options)
    frameProcessor.resume()
    await frameProcessor.process(new Float32Array(), (event) => {msg = event.msg; audio = event.audio})
    assert.strictEqual(msg, vad.Message.SpeechStart)
  })

  it("messages.SpeechEnd sent", async function () {
    let msg, audio

    let { modelFunc, resetFunc, options } = getOptions()
    const frameProcessor = new vad.FrameProcessor(modelFunc, resetFunc, options)
    frameProcessor.resume()
    const arr = [
      ...Array(options.minSpeechFrames + options.redemptionFrames).keys(),
    ]
    await frameProcessor.process([arr[0]], (event) => {msg = event.msg; audio = event.audio})
    assert.strictEqual(msg, vad.Message.SpeechStart)
    for (const i of arr.slice(1, options.minSpeechFrames)) {
      await frameProcessor.process(new Float32Array([i]), (event) => {msg = null; audio = event.audio})
      assert.isNotOk(msg)
    }
    returnNotSpeech(modelFunc, options.negativeSpeechThreshold)
    for (const i of arr.slice(options.minSpeechFrames, -1)) {
      await frameProcessor.process(new Float32Array([i]), (event) => {msg = null; audio = event.audio})
      assert.isNotOk(msg)
    }
    await frameProcessor.process(
      new Float32Array([arr[arr.length - 1]]),
      (event) => {msg = event.msg; audio = event.audio}
    )
    assert.strictEqual(msg, vad.Message.SpeechEnd)
    assertArrayEqual(audio, arr)
  })

  it("onVADMisfire called", async function () {
    let msg, audio
    let { modelFunc, resetFunc, options } = getOptions({
      minSpeechFrames: 5,
      redemptionFrames: 2,
    })
    const frameProcessor = new vad.FrameProcessor(modelFunc, resetFunc, options)
    frameProcessor.resume()
    await frameProcessor.process(new Float32Array([1]), (event) => {msg = event.msg; audio = event.audio})
    assert.strictEqual(msg, vad.Message.SpeechStart)
    returnNotSpeech(modelFunc, options.negativeSpeechThreshold)
    for (let i = 1; i <= options.redemptionFrames - 1; i++) {
      await frameProcessor.process(new Float32Array([1]), (event) => {msg = null; audio = event.audio})
      assert.isNotOk(msg)
    }
    await frameProcessor.process(new Float32Array([1]), (event) => {msg = event.msg; audio = event.audio})
    assert.strictEqual(msg, vad.Message.VADMisfire)
    assert.isNotOk(audio)
  })

  it("vad misfire with redemptionFrames > minSpeechFrames", async function () {
    let msg, audio
    let { modelFunc, resetFunc, options } = getOptions({
      minSpeechFrames: 4,
      redemptionFrames: 3,
    })
    const nSpeechFrames = 3
    const frameProcessor = new vad.FrameProcessor(modelFunc, resetFunc, options)
    frameProcessor.resume()
    await frameProcessor.process(new Float32Array([1]), (event) => {msg = event.msg; audio = event.audio})
    assert.strictEqual(msg, vad.Message.SpeechStart)
    for (let i = 1; i <= nSpeechFrames - 1; i++) {
      await frameProcessor.process(new Float32Array([1]), (event) => {msg = null; audio = event.audio})
      assert.isNotOk(msg)
    }
    returnNotSpeech(modelFunc, options.negativeSpeechThreshold)
    for (let i = 1; i <= options.redemptionFrames - 1; i++) {
      await frameProcessor.process(new Float32Array([1]), (event) => {msg = null; audio = event.audio})
      assert.isNotOk(msg)
    }
    await frameProcessor.process(new Float32Array([1]), (event) => {msg = event.msg; audio = event.audio})
    assert.strictEqual(msg, vad.Message.VADMisfire)
    assert.isNotOk(audio)
  })

  it("endSegment+vadMisfire with redemptionFrames > minSpeechFrames", async function () {
    let msg, audio
    let { modelFunc, resetFunc, options } = getOptions({
      minSpeechFrames: 4,
      redemptionFrames: 3,
    })
    const nSpeechFrames = 3
    const frameProcessor = new vad.FrameProcessor(modelFunc, resetFunc, options)
    frameProcessor.resume()
    await frameProcessor.process(new Float32Array([1]), (event) => {msg = event.msg; audio = event.audio})
    assert.strictEqual(msg, vad.Message.SpeechStart)
    for (let i = 1; i <= nSpeechFrames - 1; i++) {
      await frameProcessor.process(new Float32Array([1]), (event) => {msg = null; audio = event.audio})
      assert.isNotOk(msg)
    }
    returnNotSpeech(modelFunc, options.negativeSpeechThreshold)
    for (let i = 1; i <= options.redemptionFrames - 1; i++) {
      await frameProcessor.process(new Float32Array([1]), (event) => {msg = null; audio = event.audio})
      assert.isNotOk(msg)
    }
    await frameProcessor.endSegment((event) => {msg = event.msg; audio = null})
    assert.strictEqual(msg, vad.Message.VADMisfire)
    assert.isNotOk(audio)
  })

  it("endSegment+nothing", async function () {
    let msg, audio
    let { modelFunc, resetFunc, options } = getOptions()
    const frameProcessor = new vad.FrameProcessor(modelFunc, resetFunc, options)
    frameProcessor.resume()
    returnNotSpeech(modelFunc, options.negativeSpeechThreshold)
    await frameProcessor.process(new Float32Array([1]), (event) => {msg = null; audio = event.audio})
    assert.isNotOk(msg)
    await frameProcessor.endSegment((event) => {msg = event.msg; audio = event.audio})  
    assert.isNotOk(msg)
    assert.isNotOk(audio)
  })

  it("endSegment+speechEnd with redemptionFrames > minSpeechFrames", async function () {
    let msg, audio
    let { modelFunc, resetFunc, options } = getOptions({
      minSpeechFrames: 4,
      redemptionFrames: 3,
    })
    const frameProcessor = new vad.FrameProcessor(modelFunc, resetFunc, options)
    frameProcessor.resume()
    await frameProcessor.process(new Float32Array([1]), (event) => {msg = event.msg; audio = event.audio})
    assert.strictEqual(msg, vad.Message.SpeechStart)
    for (let i = 1; i <= options.minSpeechFrames - 1; i++) {
      await frameProcessor.process(new Float32Array([1]), (event) => {msg = null; audio = event.audio})
      assert.isNotOk(msg)
    }
    returnNotSpeech(modelFunc, options.negativeSpeechThreshold)
    for (let i = 1; i <= options.redemptionFrames - 1; i++) { 
      await frameProcessor.process(new Float32Array([1]), (event) => {msg = null; audio = event.audio})
      assert.isNotOk(msg)
    }
    await frameProcessor.endSegment((event) => {msg = event.msg; audio = event.audio})
    assert.strictEqual(msg, vad.Message.SpeechEnd)
    assertArrayEqual(
      audio,
      Array(options.minSpeechFrames + options.redemptionFrames - 1).fill(1)
    )
  })
})
