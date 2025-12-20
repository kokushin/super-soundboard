import React, { useEffect, useMemo, useRef, useState } from "react";
import appConfig from "../../config.json";

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const normalize = (text) => text.toLowerCase().replace(/\s+/g, "").trim();
const clampVolume = (value) => {
  const vol = typeof value === "number" ? value : 1;
  return Math.min(Math.max(vol, 0), 2);
};

const App = () => {
  const [wsStatus, setWsStatus] = useState("disconnected");
  const [recStatus, setRecStatus] = useState("listening");
  const [transcript, setTranscript] = useState("-");
  const [lastHit, setLastHit] = useState("-");
  const [running, setRunning] = useState(false);

  const recognitionRef = useRef(null);
  const wsRef = useRef(null);
  const wsReconnectTimerRef = useRef(null);
  const lastHitAtRef = useRef(0);
  const isMountedRef = useRef(true);
  const runningRef = useRef(false);
  const isRecognizingRef = useRef(false);
  const recognitionStartTimeRef = useRef(0);
  const recognitionResetTimerRef = useRef(null);
  const consecutiveErrorsRef = useRef(0);
  const transcriptResetTimerRef = useRef(null);

  const keywordEntries = useMemo(() => {
    const entries = [];
    (appConfig.mappings || []).forEach((m) => {
      const volume = clampVolume(m.volume);
      (m.keywords || []).forEach((kw) => {
        entries.push({
          keyword: kw,
          normalized: normalize(kw),
          volume,
        });
      });
    });
    return entries;
  }, []);

  const keywords = useMemo(() => Array.from(new Set(keywordEntries.map((entry) => entry.keyword))), [keywordEntries]);

  const detectKeyword = (text) => {
    const normalizedText = normalize(text);
    const hit = keywordEntries.find((entry) => normalizedText.includes(entry.normalized));
    return hit ? { keyword: hit.keyword, volume: hit.volume } : null;
  };

  const scheduleReconnect = () => {
    if (wsReconnectTimerRef.current) return;
    wsReconnectTimerRef.current = setTimeout(() => {
      wsReconnectTimerRef.current = null;
      if (running) {
        connectWs();
      }
    }, 2_000);
  };

  const connectWs = () => {
    try {
      const url = `ws://127.0.0.1:${appConfig.wsPort}`;
      console.log("[WebSocket] Connecting to", url);
      setWsStatus("connecting");
      wsRef.current = new WebSocket(url);
      wsRef.current.onopen = () => {
        console.log("[WebSocket] Connected");
        setWsStatus("connected");
      };
      wsRef.current.onclose = () => {
        console.log("[WebSocket] Disconnected");
        setWsStatus("disconnected");
        scheduleReconnect();
      };
      wsRef.current.onerror = (error) => {
        console.error("[WebSocket] Error", error);
        setWsStatus("error");
        scheduleReconnect();
      };
    } catch (error) {
      console.error("[WebSocket] Failed to create connection", error);
      setWsStatus("error");
      scheduleReconnect();
    }
  };

  const disconnectWs = () => {
    if (wsReconnectTimerRef.current) {
      clearTimeout(wsReconnectTimerRef.current);
      wsReconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    setWsStatus("disconnected");
  };

  const sendHit = (keyword, text, volume) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.warn("[WebSocket] WS not ready, hit skipped", { keyword, text });
      return;
    }
    const payload = {
      type: "hit",
      keyword,
      text,
      ts: Date.now(),
      volume: clampVolume(volume),
    };
    console.log("[WebSocket] Sending hit", payload);
    wsRef.current.send(JSON.stringify(payload));
  };

  const handleResult = (event) => {
    // continuous: false なので、常に results[0] が最新の結果
    if (!event.results || event.results.length === 0) {
      return;
    }

    const result = event.results[0];
    if (!result || result.length === 0) {
      return;
    }

    const alternative = result[0];
    const text = (alternative.transcript || "").trim();
    const confidence = alternative.confidence || 0;
    const isFinal = result.isFinal;

    console.log("[Recognition]", isFinal ? "Final" : "Interim", "result:", text, "confidence:", confidence);

    // UI 更新
    setTranscript(text || "-");

    // 確定結果のみ処理
    if (!isFinal) {
      return;
    }

    // 3秒後に表示をリセット
    if (transcriptResetTimerRef.current) {
      clearTimeout(transcriptResetTimerRef.current);
    }
    if (text) {
      transcriptResetTimerRef.current = setTimeout(() => {
        setTranscript("-");
      }, 3000);
    }

    // 信頼度チェック
    if (!text || confidence < 0.3) {
      console.log("[Recognition] Skipped: low confidence or empty");
      return;
    }

    // キーワード検出
    const hit = detectKeyword(text);
    if (!hit) {
      console.log("[Recognition] No keyword match");
      return;
    }

    // クールダウンチェック
    const now = Date.now();
    if (now - lastHitAtRef.current < appConfig.cooldownMs) {
      console.log("[Recognition] Cooldown active, ignoring hit");
      return;
    }

    // ヒット送信
    lastHitAtRef.current = now;
    sendHit(hit.keyword, text, hit.volume);
    const timeLabel = new Date().toLocaleTimeString();
    setLastHit(`${timeLabel} : ${hit.keyword} (${text})`);
    console.log("[Recognition] ✓ Keyword hit:", hit.keyword);
  };

  const buildRecognition = () => {
    if (!SpeechRecognition) {
      alert("このブラウザでは Web Speech API が使えません。Chrome を利用してください。");
      return null;
    }
    console.log("[Recognition] Building new recognition instance");
    const rec = new SpeechRecognition();
    rec.lang = appConfig.lang;
    rec.interimResults = true;
    rec.continuous = false; // 連続モードをオフにして結果の蓄積を防ぐ
    rec.maxAlternatives = 1;

    rec.onresult = handleResult;

    rec.onstart = () => {
      isRecognizingRef.current = true;
      consecutiveErrorsRef.current = 0;
      recognitionStartTimeRef.current = Date.now();
      setRecStatus("listening");
      console.log("[Recognition] Started");
    };

    rec.onerror = (event) => {
      const errorType = event?.error || "unknown";
      isRecognizingRef.current = false;

      // no-speech は無視（よくあるエラー）
      if (errorType === "no-speech") {
        console.log("[Recognition] No speech detected");
        return;
      }

      console.error("[Recognition] Error:", errorType);
      consecutiveErrorsRef.current += 1;

      // 連続エラーが多い場合はインスタンスを再生成
      if (consecutiveErrorsRef.current >= 3) {
        console.warn("[Recognition] Too many errors, will rebuild");
        recognitionRef.current = null;
        consecutiveErrorsRef.current = 0;
      }
    };

    rec.onend = () => {
      const uptime = Date.now() - recognitionStartTimeRef.current;
      isRecognizingRef.current = false;
      console.log("[Recognition] Ended (uptime:", Math.round(uptime / 1000), "s)");

      // continuous: false なので、各認識後に自動的に終了する
      // すぐに再開して次の音声を待機
      if (runningRef.current && isMountedRef.current) {
        setTimeout(() => restartRecognition(), 100);
      }
    };
    return rec;
  };

  const startRecognition = () => {
    if (!recognitionRef.current) {
      recognitionRef.current = buildRecognition();
    }
    if (!recognitionRef.current) return;

    try {
      recognitionRef.current.start();
    } catch (error) {
      console.error("[Recognition] Start failed:", error.message);
    }
  };

  const restartRecognition = () => {
    // すでに認識中の場合はスキップ
    if (isRecognizingRef.current) {
      return;
    }

    // 停止中の場合は再構築が必要かチェック
    if (!recognitionRef.current) {
      recognitionRef.current = buildRecognition();
    }

    if (!recognitionRef.current) {
      console.error("[Recognition] Failed to build instance");
      return;
    }

    try {
      recognitionRef.current.start();
    } catch (error) {
      // InvalidStateError の場合はインスタンスを再生成
      if (error.name === "InvalidStateError") {
        recognitionRef.current = null;
        setTimeout(() => restartRecognition(), 200);
      } else {
        console.error("[Recognition] Restart failed:", error.message);
      }
    }
  };

  const stopRecognition = () => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (e) {
        // ignore
      }
    }
    recognitionRef.current = null;
    isRecognizingRef.current = false;
  };

  const forceResetRecognition = () => {
    console.log("[Recognition] Periodic reset");
    stopRecognition();
    consecutiveErrorsRef.current = 0;

    if (runningRef.current && isMountedRef.current) {
      setTimeout(() => startRecognition(), 500);
    }
  };

  const schedulePeriodicReset = () => {
    if (recognitionResetTimerRef.current) {
      clearInterval(recognitionResetTimerRef.current);
    }
    // 2分ごとにリセット
    recognitionResetTimerRef.current = setInterval(() => {
      if (runningRef.current) {
        forceResetRecognition();
      }
    }, 2 * 60 * 1000);
    console.log("[Recognition] Periodic reset: every 2 minutes");
  };

  const clearPeriodicReset = () => {
    if (recognitionResetTimerRef.current) {
      clearInterval(recognitionResetTimerRef.current);
      recognitionResetTimerRef.current = null;
    }
  };

  const handleStart = () => {
    console.log("[App] Start");
    setRunning(true);
    runningRef.current = true;
    lastHitAtRef.current = 0;
    consecutiveErrorsRef.current = 0;

    connectWs();
    startRecognition();
    schedulePeriodicReset();
  };

  const handleStop = () => {
    console.log("[App] Stop");
    setRunning(false);
    runningRef.current = false;

    clearPeriodicReset();
    stopRecognition();
    disconnectWs();
  };

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      clearPeriodicReset();
      if (transcriptResetTimerRef.current) {
        clearTimeout(transcriptResetTimerRef.current);
      }
      handleStop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app">
      <h1>super-soundboard</h1>
      <p className="hint">
        Chromeで開き、マイク許可を与えてください。キーワードが検出されると、localhostのWebSocket経由でBotへ通知します。
      </p>

      <div className="controls">
        <button onClick={handleStart} disabled={running}>
          Start
        </button>
        <button onClick={handleStop} disabled={!running}>
          Stop
        </button>
      </div>

      <div className="status-grid">
        <div className="status-card">
          <div className="label">WS接続</div>
          <div className="value">{wsStatus}</div>
        </div>
        <div className="status-card">
          <div className="label">認識状態</div>
          <div className="value">{recStatus}</div>
        </div>
        <div className="status-card">
          <div className="label">最後のhit</div>
          <div className="value">{lastHit}</div>
        </div>
      </div>

      <div className="output">
        <div className="label">認識テキスト</div>
        <div className="transcript">{transcript}</div>
      </div>

      <div className="output">
        <div className="label">キーワード一覧</div>
        <div id="keywords">
          {keywords.map((kw) => (
            <span key={kw} className="tag">
              {kw}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};

export default App;
