/**
 * 代理程式進入「已完成」時要響的提示音。
 *
 * 用 Web Audio 即時合成而不是播放音檔：Overlay 不必多帶一個 asset，離線可用，
 * 音色也能直接在這裡調。音色是 A5→E6 的柔和雙音（soft-chime），加一顆很輕的
 * 泛音讓尾巴不死板。
 */

/** localStorage 鍵；只存「開／關」，音量由下面的常數決定。 */
const completionSoundStorageKey = "agent-lantern.completionSound";

/** 主音量。整個提示音的響度上限，調這個就好。 */
const completionSoundVolume = 0.45;

let audioContext: AudioContext | undefined;
let masterGain: GainNode | undefined;
let isEnabled = loadCompletionSoundEnabled();

function loadCompletionSoundEnabled(): boolean {
  try {
    // 沒存過就預設開啟——使用者裝這個工具就是為了知道代理程式跑完了。
    return window.localStorage.getItem(completionSoundStorageKey) !== "off";
  } catch {
    return true;
  }
}

export function isCompletionSoundEnabled(): boolean {
  return isEnabled;
}

export function setCompletionSoundEnabled(enabled: boolean): void {
  isEnabled = enabled;
  try {
    window.localStorage.setItem(
      completionSoundStorageKey,
      enabled ? "on" : "off",
    );
  } catch {
    // 無法寫入時忽略，這次啟動期間仍以記憶體內的選擇運作。
  }
}

/**
 * 建立（或取回）AudioContext。瀏覽器／WebView 的自動播放政策可能讓 context
 * 一開始就是 suspended，所以每次都嘗試 resume()——在使用者已經跟視窗互動過之後
 * 這個呼叫會成功。
 */
function ensureAudioContext(): AudioContext | undefined {
  try {
    if (!audioContext) {
      audioContext = new AudioContext();
      masterGain = audioContext.createGain();
      masterGain.gain.value = completionSoundVolume;
      masterGain.connect(audioContext.destination);
    }
    if (audioContext.state === "suspended") {
      void audioContext.resume();
    }
    return audioContext;
  } catch {
    // 沒有 Web Audio 的環境：提示音靜默失效，不影響 Overlay 其他功能。
    return undefined;
  }
}

/**
 * 在使用者第一次跟視窗互動時先把 AudioContext 解鎖，這樣真正要響的那一刻
 * （由輪詢觸發、不是使用者手勢）才不會被自動播放政策擋掉。
 */
export function primeAudioPlayback(): void {
  ensureAudioContext();
}

/** 一顆帶 attack／指數衰減包絡的正弦音。 */
function scheduleTone(
  context: AudioContext,
  destination: AudioNode,
  startTime: number,
  options: { frequency: number; peak: number; decaySeconds: number },
): void {
  const attackSeconds = 0.005;
  const gain = context.createGain();
  // 指數斜坡不能從 0 出發，所以起點用一個極小值。
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.linearRampToValueAtTime(options.peak, startTime + attackSeconds);
  gain.gain.exponentialRampToValueAtTime(
    0.0001,
    startTime + attackSeconds + options.decaySeconds,
  );
  gain.connect(destination);

  const oscillator = context.createOscillator();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(options.frequency, startTime);
  oscillator.connect(gain);
  oscillator.start(startTime);
  oscillator.stop(startTime + attackSeconds + options.decaySeconds + 0.08);
}

/**
 * 響一次完成提示音。預設會遵守開／關設定；設定面板的「試聽」要在關閉狀態下
 * 也能聽到，所以用 force 略過那道檢查。
 */
export function playCompletionChime(
  options: { force?: boolean } = {},
): void {
  if (!isEnabled && !options.force) {
    return;
  }

  const context = ensureAudioContext();
  if (!context || !masterGain) {
    return;
  }

  // 稍微往後排一點，避免排在已經過去的時間點上而被吃掉第一個 attack。
  const startTime = context.currentTime + 0.02;
  scheduleTone(context, masterGain, startTime, {
    frequency: 880,
    peak: 0.5,
    decaySeconds: 0.9,
  });
  scheduleTone(context, masterGain, startTime + 0.12, {
    frequency: 1318.5,
    peak: 0.42,
    decaySeconds: 1.1,
  });
  scheduleTone(context, masterGain, startTime + 0.12, {
    frequency: 2637,
    peak: 0.06,
    decaySeconds: 0.5,
  });
}
