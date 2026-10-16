/**
 * ==========================================================================
 * app.js
 * 学習補助UIコントローラ（①観測 → ②算出 → ③解釈 の統合制御）
 * ==========================================================================
 */

(function () {
  "use strict";

  let hrChart = null;
  let currentStars = [];
  let landmarks = [];
  let currentPresetId = "composite";
  let currentQuizStar = null;

  document.addEventListener("DOMContentLoaded", () => {
    // 1. KaTeX 数式レンダリング初期化
    renderMath();

    // 2. ランドマークと初期実観測データセットのロード
    landmarks = GaiaTAP.getEnrichedLandmarks();
    currentStars = GaiaTAP.getInstantDataset("composite");

    // 3. HR図レンダラー初期化
    hrChart = new HRChartRenderer.HRChart("hr-chart-container", {
      onStarSelect: (star) => {
        handleStarSelection(star);
      },
      onBrushSelect: (brushedStars) => {
        updateRegionStats(brushedStars.length > 0 ? brushedStars : currentStars, brushedStars.length > 0);
      }
    });

    hrChart.setData(currentStars, landmarks);

    // 4. UIイベントバインディング
    initStepTabs();
    initStep1Controls();
    initStep2SimulatorAndQuiz();
    initStep3Controls();
    initToolbarAndModal();
    initFirstMagSelector();

    // 5. 初期表示の反映
    populateRawTable(currentStars);
    updateRegionStats(currentStars, false);
    updateIsochroneReadout(8.80);

    // 初期選択として一等星シリウスまたは太陽をセット
    const initialStar = landmarks[0] || currentStars[0];
    if (initialStar) {
      hrChart.selectStar(initialStar, true);
    }
    pickNewQuizStar();

    // 6. 初回起動時にバックグラウンドでリアルタイムTAPクエリも試行しステータス表示を更新
    triggerLiveTapFetch("composite", false);
  });

  /**
   * 一等星（全21星）＋太陽・基準星のクイック選択バー＆ドロップダウン初期化
   */
  function initFirstMagSelector() {
    const selectEl = document.getElementById("select-first-mag");
    const pillContainer = document.getElementById("first-mag-pill-container");
    if (!selectEl || !pillContainer) return;

    // ドロップダウン構築
    const firstMagList = landmarks.filter((l) => l.isFirstMag);
    const refList = landmarks.filter((l) => !l.isFirstMag);

    const optGroup1 = document.createElement("optgroup");
    optGroup1.label = "★ 一等星（全21恒星・日本語名）";
    firstMagList.forEach((lm) => {
      const opt = document.createElement("option");
      opt.value = lm.id;
      opt.textContent = `★ ${lm.name} [m=${lm.m_G.toFixed(2)}, M=${lm.M_G.toFixed(2)}, ${lm.regionNameJa}]`;
      optGroup1.appendChild(opt);
    });
    selectEl.appendChild(optGroup1);

    const optGroup2 = document.createElement("optgroup");
    optGroup2.label = "基準恒星（太陽・代表白色矮星・赤色矮星）";
    refList.forEach((lm) => {
      const opt = document.createElement("option");
      opt.value = lm.id;
      opt.textContent = `・ ${lm.name} [m=${lm.m_G.toFixed(2)}, M=${lm.M_G.toFixed(2)}, ${lm.regionNameJa}]`;
      optGroup2.appendChild(opt);
    });
    selectEl.appendChild(optGroup2);

    selectEl.addEventListener("change", () => {
      const targetId = selectEl.value;
      if (!targetId) return;
      const found = landmarks.find((l) => l.id === targetId);
      if (found) {
        ensureLandmarksVisible();
        hrChart.selectStar(found, true);
      }
    });

    // ワンクリック日本語ピルボタン群の構築（全21個の一等星＋太陽）
    pillContainer.innerHTML = landmarks
      .map((lm) => {
        const label = lm.isFirstMag ? `★${lm.shortName}` : lm.shortName;
        return `
        <button
          type="button"
          data-landmark-id="${lm.id}"
          title="${lm.name} (${lm.regionNameJa} / 有効温度 ${Math.round(lm.teff).toLocaleString()}K)"
          class="first-mag-pill shrink-0 px-2 py-0.5 text-[11px] font-medium border border-neutral-800 bg-white text-neutral-900 hover:bg-neutral-200 transition flex items-center gap-1"
        >
          <span class="inline-block w-2 h-2 border border-neutral-900 shrink-0" style="background-color: ${lm.colorHex};"></span>
          <span>${label}</span>
        </button>
      `;
      })
      .join("");

    pillContainer.querySelectorAll(".first-mag-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-landmark-id");
        const found = landmarks.find((l) => l.id === id);
        if (found) {
          ensureLandmarksVisible();
          hrChart.selectStar(found, true);
        }
      });
    });
  }

  function ensureLandmarksVisible() {
    const chk = document.getElementById("chk-overlay-landmarks");
    if (chk && !chk.checked) {
      chk.checked = true;
      hrChart.setOption("showLandmarks", true);
    }
  }

  function renderMath() {
    if (window.renderMathInElement) {
      window.renderMathInElement(document.body, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false }
        ],
        throwOnError: false
      });
    } else {
      // KaTeXスクリプトのロード待ちリトライ
      setTimeout(renderMath, 150);
    }
  }

  /**
   * 3段階プロセスタブ（①観測 / ②算出 / ③解釈）の切り替え
   */
  function initStepTabs() {
    const tabButtons = document.querySelectorAll(".step-tab");
    const panels = {
      "1": document.getElementById("panel-step-1"),
      "2": document.getElementById("panel-step-2"),
      "3": document.getElementById("panel-step-3")
    };

    tabButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const step = btn.getAttribute("data-step");
        tabButtons.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");

        Object.keys(panels).forEach((k) => {
          if (k === step) {
            panels[k].classList.remove("hidden");
          } else {
            panels[k].classList.add("hidden");
          }
        });

        // ステップ②または③に移った際は、物理HR図（絶対等級 M_G）モードへ自動復帰
        if ((step === "2" || step === "3") && hrChart.options.yAxisMode !== "absolute") {
          setYAxisModeUI("absolute");
        }
      });
    });
  }

  /**
   * STEP ①: 観測データ取得（Gaia TAP API クエリ・プリセット・生データテーブル・視等級比較）
   */
  function initStep1Controls() {
    const selectPreset = document.getElementById("select-tap-preset");
    const presetDesc = document.getElementById("preset-description");
    const textareaAdql = document.getElementById("textarea-adql");
    const selectEndpoint = document.getElementById("select-tap-endpoint");
    const btnRunTap = document.getElementById("btn-run-tap");

    // 初期ADQLセット
    textareaAdql.value = GaiaTAP.PRESETS.composite.adql;

    selectPreset.addEventListener("change", () => {
      const pid = selectPreset.value;
      currentPresetId = pid;
      const preset = GaiaTAP.PRESETS[pid];
      if (preset) {
        presetDesc.textContent = preset.description;
        textareaAdql.value = preset.adql;
        if (preset.recommendedLogAge) {
          setIsochroneAgeUI(preset.recommendedLogAge);
        }
        // プリセット選択時に即時描画＋ライブTAP取得を実行
        const instant = GaiaTAP.getInstantDataset(pid);
        applyDataset(instant);
        triggerLiveTapFetch(pid, false);
      }
    });

    btnRunTap.addEventListener("click", () => {
      triggerLiveTapFetch(currentPresetId, true);
    });

    // 視等級 m_G vs 絶対等級 M_G 比較ボタン
    document.getElementById("btn-mode-apparent").addEventListener("click", () => {
      setYAxisModeUI("apparent");
    });
    document.getElementById("btn-mode-absolute").addEventListener("click", () => {
      setYAxisModeUI("absolute");
    });

    // CSV出力・読込
    document.getElementById("btn-export-csv").addEventListener("click", () => {
      const csv = GaiaTAP.exportToCsv(currentStars);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `gaia_hr_data_${currentPresetId}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });

    document.getElementById("input-import-csv").addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const parsed = GaiaTAP.parseCsvData(String(ev.target.result));
          if (parsed.length === 0) {
            alert("有効な恒星データ行が見つかりませんでした。");
            return;
          }
          applyDataset(parsed);
          setTapStatus("CSV読込完了", `${file.name}: ${parsed.length} 天体をプロットしました`);
        } catch (err) {
          alert(`CSV読込エラー: ${err.message}`);
        }
      };
      reader.readAsText(file);
    });
  }

  async function triggerLiveTapFetch(presetId, useCustomTextarea) {
    const textareaAdql = document.getElementById("textarea-adql");
    const selectEndpoint = document.getElementById("select-tap-endpoint");
    const btnRunTap = document.getElementById("btn-run-tap");

    setTapStatus("TAP 通信中...", "Gaia DR3 TAP サーバーへ ADQL クエリを送信しています...");
    btnRunTap.disabled = true;
    btnRunTap.classList.add("opacity-60");

    try {
      const result = await GaiaTAP.executeQuery({
        presetId,
        customAdql: useCustomTextarea ? textareaAdql.value : null,
        endpoint: selectEndpoint.value
      });

      applyDataset(result.stars);
      const badgeText =
        result.source === "LIVE_TAP_API"
          ? `LIVE取得 (${result.elapsedMs}ms)`
          : result.source === "FIRST_MAG_CATALOG"
          ? `一等星カタログ`
          : `内蔵DR3 (${result.stars.length}星)`;
      setTapStatus(badgeText, result.message);
    } finally {
      btnRunTap.disabled = false;
      btnRunTap.classList.remove("opacity-60");
    }
  }

  function setTapStatus(badgeText, logText) {
    const badge = document.getElementById("tap-status-badge");
    const log = document.getElementById("tap-log-message");
    if (badge) badge.textContent = badgeText;
    if (log) log.textContent = logText;
  }

  function applyDataset(stars) {
    currentStars = stars;
    hrChart.setData(currentStars, landmarks);
    populateRawTable(currentStars);
    updateRegionStats(currentStars, false);
    if (currentStars.length > 0) {
      handleStarSelection(hrChart.selectedStar || landmarks[0] || currentStars[0]);
      pickNewQuizStar();
    }
  }

  /**
   * 観測生データテーブルの描画とクリック連動（一等星全21星も先頭に日本語名で一覧表示）
   */
  let currentTableRowsData = [];

  function populateRawTable(stars) {
    const tbody = document.getElementById("tbody-raw-stars");
    const countLabel = document.getElementById("table-count-label");

    // すでに stars がランドマーク自身（first_mag_only）の場合はそのまま、それ以外は一等星・基準星を先頭に結合していつでも選択可能にする
    const hasLandmarksInside = stars.length > 0 && stars[0].isLandmark;
    const combined = hasLandmarksInside ? stars : landmarks.concat(stars.slice(0, 100));
    currentTableRowsData = combined;

    countLabel.textContent = hasLandmarksInside
      ? `一等星・基準星 ${stars.length} 天体`
      : `一等星21+基準4 / 観測 ${stars.length} 天体`;

    tbody.innerHTML = combined
      .map((s, idx) => {
        const displayName = s.name
          ? `${s.isFirstMag ? "★ " : ""}${s.name}`
          : s.id.slice(0, 13);
        return `
      <tr data-star-idx="${idx}" data-star-id="${s.id}" class="cursor-pointer hover:bg-neutral-200 transition">
        <td class="py-1 px-2 truncate max-w-[145px] ${s.isFirstMag ? "font-bold" : ""}" title="${s.name || "Gaia DR3 " + s.id}">
          ${displayName}
        </td>
        <td class="py-1 px-1.5 text-right">${s.m_G.toFixed(2)}</td>
        <td class="py-1 px-1.5 text-right">${s.parallax.toFixed(2)}</td>
        <td class="py-1 px-2 text-right">${s.bp_rp.toFixed(2)}</td>
      </tr>
    `;
      })
      .join("");

    tbody.querySelectorAll("tr").forEach((tr) => {
      tr.addEventListener("click", () => {
        const idx = Number(tr.getAttribute("data-star-idx"));
        const star = currentTableRowsData[idx];
        if (star) {
          if (star.isLandmark) ensureLandmarksVisible();
          hrChart.selectStar(star, true);
        }
      });
    });
  }

  /**
   * STEP ②: 物理量算出シミュレータ & 検算ミニ演習
   */
  function initStep2SimulatorAndQuiz() {
    const inputM = document.getElementById("sim-input-m");
    const inputPlx = document.getElementById("sim-input-plx");
    const inputBpRp = document.getElementById("sim-input-bprp");

    const onSimInput = () => {
      const m_G = parseFloat(inputM.value);
      const parallax = parseFloat(inputPlx.value);
      const bp_rp = parseFloat(inputBpRp.value);

      const syntheticStar = Astrophysics.enrichStarRecord(
        {
          id: "SIM-CUSTOM",
          name: "シミュレータ手動設定値",
          m_G,
          parallax,
          bp_rp
        },
        0
      );

      updateSimulatorTraceUI(syntheticStar, false);
      hrChart.selectStar(syntheticStar, false);
    };

    inputM.addEventListener("input", onSimInput);
    inputPlx.addEventListener("input", onSimInput);
    inputBpRp.addEventListener("input", onSimInput);

    // 検算クイズ
    document.getElementById("btn-new-quiz").addEventListener("click", pickNewQuizStar);
    document.getElementById("btn-check-quiz").addEventListener("click", checkQuizAnswer);
    document.getElementById("input-quiz-answer").addEventListener("keydown", (e) => {
      if (e.key === "Enter") checkQuizAnswer();
    });
  }

  function updateSimulatorTraceUI(star, syncSliders = true) {
    const titleEl = document.getElementById("calc-star-title");
    const valMEl = document.getElementById("sim-val-m");
    const valPlxEl = document.getElementById("sim-val-plx");
    const valBpRpEl = document.getElementById("sim-val-bprp");

    titleEl.textContent = star.name ? star.name : `Gaia DR3 ${String(star.id).slice(0, 12)}`;
    valMEl.textContent = `${star.m_G.toFixed(2)} mag`;
    valPlxEl.textContent = `${star.parallax.toFixed(2)} mas`;
    valBpRpEl.textContent = `${star.bp_rp.toFixed(2)} mag`;

    if (syncSliders) {
      document.getElementById("sim-input-m").value = Math.max(-1.5, Math.min(18.5, star.m_G));
      document.getElementById("sim-input-plx").value = Math.max(0.5, Math.min(300, star.parallax));
      document.getElementById("sim-input-bprp").value = Math.max(-0.55, Math.min(3.4, star.bp_rp));
    }

    const logTerm = Math.log10(star.parallax / 1000.0);
    const fiveLogTerm = 5.0 * logTerm;

    document.getElementById("trace-formula-dist").textContent =
      `d = 1000 / ${star.parallax.toFixed(2)} = ${star.distancePc.toFixed(2)} pc (${star.distanceLy.toFixed(1)} 光年)`;

    document.getElementById("trace-formula-abs").textContent =
      `M = ${star.m_G.toFixed(2)} + 5 + 5×log10(${(star.parallax / 1000).toFixed(5)}) = ${star.m_G.toFixed(2)} + 5 + (${fiveLogTerm.toFixed(2)}) = ${star.M_G.toFixed(2)} mag`;

    document.getElementById("trace-formula-teff").textContent =
      `T_eff = ${Math.round(star.teff).toLocaleString()} K (${star.spectralType} / ${star.regionNameJa})`;

    const swatch = document.getElementById("trace-color-swatch");
    swatch.style.backgroundColor = star.colorHex;

    const lumStr =
      star.luminositySolar >= 0.01 && star.luminositySolar < 1000
        ? star.luminositySolar.toFixed(2)
        : star.luminositySolar.toExponential(2);
    const radStr =
      star.radiusSolar >= 0.01 && star.radiusSolar < 1000
        ? star.radiusSolar.toFixed(2)
        : star.radiusSolar.toExponential(2);

    document.getElementById("trace-formula-lumrad").textContent =
      `L = ${lumStr} L☉ ,  R = ${radStr} R☉`;
  }

  function pickNewQuizStar() {
    if (!currentStars || currentStars.length === 0) return;
    const idx = Math.floor(Math.random() * currentStars.length);
    currentQuizStar = currentStars[idx];

    document.getElementById("quiz-star-name").textContent = currentQuizStar.name
      ? currentQuizStar.name
      : `Gaia DR3 ${currentQuizStar.id.slice(0, 12)}`;
    document.getElementById("quiz-m").textContent = currentQuizStar.m_G.toFixed(2);
    document.getElementById("quiz-plx").textContent = currentQuizStar.parallax.toFixed(2);
    const logVal = Math.log10(currentQuizStar.parallax / 1000.0);
    document.getElementById("quiz-log-hint").textContent = logVal.toFixed(4);
    document.getElementById("input-quiz-answer").value = "";

    const fb = document.getElementById("quiz-feedback");
    fb.classList.add("hidden");
  }

  function checkQuizAnswer() {
    if (!currentQuizStar) return;
    const userVal = parseFloat(document.getElementById("input-quiz-answer").value);
    const fb = document.getElementById("quiz-feedback");
    fb.classList.remove("hidden");

    if (isNaN(userVal)) {
      fb.textContent = "数値を入力してください。";
      return;
    }

    const trueM = currentQuizStar.M_G;
    const diff = Math.abs(userVal - trueM);
    if (diff <= 0.12) {
      fb.innerHTML = `<strong>正解です！</strong> 算出値 M = ${trueM.toFixed(2)} mag（距離 d = ${currentQuizStar.distancePc.toFixed(1)} pc, 分類: ${currentQuizStar.regionNameJa}）。HR図上でこの星をハイライトしました。`;
      hrChart.selectStar(currentQuizStar, true);
    } else {
      const fiveLog = 5 * Math.log10(currentQuizStar.parallax / 1000);
      fb.innerHTML = `惜しい！（入力: ${userVal.toFixed(2)} / 正解: <strong>${trueM.toFixed(2)} mag</strong>）<br/>式: M = ${currentQuizStar.m_G.toFixed(2)} + 5 + (${fiveLog.toFixed(2)}) = ${trueM.toFixed(2)} mag`;
    }
  }

  /**
   * STEP ③: 等年齢線フィッティング & 物理的解釈パネル
   */
  function initStep3Controls() {
    const sliderIso = document.getElementById("slider-isochrone-age");
    const chkStep3Iso = document.getElementById("chk-step3-isochrone");
    const chkToolbarIso = document.getElementById("chk-overlay-isochrone");

    sliderIso.addEventListener("input", () => {
      const logAge = parseFloat(sliderIso.value);
      setIsochroneAgeUI(logAge);
    });

    chkStep3Iso.addEventListener("change", () => {
      chkToolbarIso.checked = chkStep3Iso.checked;
      hrChart.setOption("showIsochrone", chkStep3Iso.checked);
    });

    // ワンクリック星団年齢フィットボタン
    document.querySelectorAll(".btn-fit-age").forEach((btn) => {
      btn.addEventListener("click", () => {
        const logAge = parseFloat(btn.getAttribute("data-fit-age"));
        const clusterId = btn.getAttribute("data-fit-cluster");
        setIsochroneAgeUI(logAge);

        // もし現在のデータセットがその星団でなければ星団プリセットもロード
        if (clusterId && currentPresetId !== clusterId) {
          const selectPreset = document.getElementById("select-tap-preset");
          selectPreset.value = clusterId;
          selectPreset.dispatchEvent(new Event("change"));
        }
      });
    });
  }

  function setIsochroneAgeUI(logAge) {
    const sliderIso = document.getElementById("slider-isochrone-age");
    sliderIso.value = logAge;
    hrChart.setOption("logAgeYr", logAge);
    updateIsochroneReadout(logAge);
  }

  function updateIsochroneReadout(logAge) {
    const iso = Astrophysics.generateIsochrone(logAge);
    const disp = document.getElementById("iso-age-display");
    const summary = document.getElementById("iso-turnoff-summary");

    disp.textContent = `10^${logAge.toFixed(2)} yr (${iso.ageTextJa})`;
    summary.innerHTML = `
      <div>主系列離脱点 (MSTO) 質量: <strong>約 ${iso.turnoff.turnoffMassSolar.toFixed(2)} M☉</strong></div>
      <div>離脱点 色指数 / 有効温度: <strong>BP-RP = ${iso.turnoff.bp_rp.toFixed(2)} mag (${Math.round(iso.turnoff.teff).toLocaleString()} K)</strong></div>
    `;
  }

  /**
   * 恒星がクリック・選択された際の全パネル同期更新
   */
  function handleStarSelection(star) {
    if (!star) return;

    // 1. STEP ② シミュレータ更新
    updateSimulatorTraceUI(star, true);

    // 2. STEP ③ 解釈カード更新
    document.getElementById("interp-star-badge").textContent = star.regionNameJa;
    document.getElementById("interp-star-name").textContent = star.name
      ? star.name
      : `Gaia DR3 ${String(star.id).slice(0, 14)}`;
    document.getElementById("interp-star-spec").textContent = `${star.spectralType} (${Math.round(star.teff).toLocaleString()} K)`;
    document.getElementById("interp-star-mass").textContent = star.massSolar
      ? `約 ${star.massSolar.toFixed(2)} M☉`
      : "-";
    document.getElementById("interp-star-life").textContent = star.lifetimeTextJa;
    document.getElementById("interp-star-lum").textContent = star.luminositySolar
      ? `${star.luminositySolar >= 0.01 && star.luminositySolar < 1000 ? star.luminositySolar.toFixed(2) : star.luminositySolar.toExponential(2)} L☉`
      : "-";
    document.getElementById("interp-star-rad").textContent = star.radiusSolar
      ? `${star.radiusSolar >= 0.01 && star.radiusSolar < 1000 ? star.radiusSolar.toFixed(2) : star.radiusSolar.toExponential(2)} R☉`
      : "-";
    document.getElementById("interp-region-explanation").innerHTML = `
      <div class="font-bold mb-1">【${star.regionNameJa} (${star.regionNameEn})】</div>
      <div>${star.regionDesc || ""}</div>
      <div class="mt-1 text-[11px] text-neutral-600">備考: ${star.massNote || ""}</div>
    `;

    // 3. フッターサマリー更新
    const footer = document.getElementById("footer-selected-summary");
    footer.textContent = `選択中: ${star.name || "Gaia DR3 " + String(star.id).slice(0, 10)} | m_G=${star.m_G.toFixed(2)}, ϖ=${star.parallax.toFixed(2)}mas → M_G=${star.M_G.toFixed(2)}, T_eff=${Math.round(star.teff)}K (${star.regionNameJa})`;

    // 4. テーブルのハイライト連動
    const rows = document.querySelectorAll("#tbody-raw-stars tr");
    rows.forEach((r) => {
      const rowId = r.getAttribute("data-star-id");
      if (rowId === String(star.id)) {
        r.classList.add("star-row-selected");
      } else {
        r.classList.remove("star-row-selected");
      }
    });

    // 5. 一等星クイック選択ピルボタン＆ドロップダウンのハイライト同期
    const selectFirstMag = document.getElementById("select-first-mag");
    if (selectFirstMag) {
      const isInLandmark = landmarks.some((l) => l.id === star.id);
      selectFirstMag.value = isInLandmark ? star.id : "";
    }

    document.querySelectorAll(".first-mag-pill").forEach((btn) => {
      const lid = btn.getAttribute("data-landmark-id");
      if (lid === star.id) {
        btn.classList.remove("bg-white", "text-neutral-900", "hover:bg-neutral-200");
        btn.classList.add("bg-neutral-950", "text-white", "font-bold");
      } else {
        btn.classList.add("bg-white", "text-neutral-900", "hover:bg-neutral-200");
        btn.classList.remove("bg-neutral-950", "text-white", "font-bold");
      }
    });
  }

  /**
   * STEP ③-C: 領域別恒星数の集計表示
   */
  function updateRegionStats(stars, isBrushSubset) {
    const scopeLabel = document.getElementById("stats-scope-label");
    scopeLabel.textContent = isBrushSubset
      ? `ブラシ選択範囲 (${stars.length} 天体)`
      : `全プロット対象 (${stars.length} 天体)`;

    const counts = {
      main_sequence: 0,
      red_giant: 0,
      subgiant: 0,
      white_dwarf: 0,
      supergiant: 0
    };

    stars.forEach((s) => {
      if (counts[s.regionId] !== undefined) {
        counts[s.regionId]++;
      }
    });

    const total = Math.max(1, stars.length);
    const items = [
      { label: "主系列星 (MS)", count: counts.main_sequence },
      { label: "赤色巨星・準巨星", count: counts.red_giant + counts.subgiant },
      { label: "白色矮星 (WD)", count: counts.white_dwarf },
      { label: "超巨星 (SG)", count: counts.supergiant }
    ];

    const grid = document.getElementById("region-stats-grid");
    grid.innerHTML = items
      .map((it) => {
        const pct = ((it.count / total) * 100).toFixed(1);
        return `
        <div class="border border-neutral-300 bg-neutral-50 p-2 flex items-center justify-between">
          <span class="text-[11px] text-neutral-700">${it.label}</span>
          <span class="font-bold">${it.count} <span class="text-[10px] font-normal text-neutral-500">(${pct}%)</span></span>
        </div>
      `;
      })
      .join("");
  }

  /**
   * ツールバー（軸切替・オーバーレイ・ズーム・モーダル）の制御
   */
  function initToolbarAndModal() {
    // 縦軸切替 (絶対等級 M_G vs 視等級 m_G)
    document.getElementById("toolbar-y-abs").addEventListener("click", () => {
      setYAxisModeUI("absolute");
    });
    document.getElementById("toolbar-y-app").addEventListener("click", () => {
      setYAxisModeUI("apparent");
    });

    // 横軸切替 (G_BP - G_RP vs B - V)
    const btnXbp = document.getElementById("toolbar-x-bprp");
    const btnXbv = document.getElementById("toolbar-x-bv");
    btnXbp.addEventListener("click", () => {
      btnXbp.className = "px-2 py-1 font-mono-num font-semibold bg-neutral-950 text-white text-[11px]";
      btnXbv.className = "px-2 py-1 font-mono-num font-semibold bg-white text-neutral-800 hover:bg-neutral-100 text-[11px]";
      hrChart.setOption("xAxisMode", "bp_rp");
    });
    btnXbv.addEventListener("click", () => {
      btnXbv.className = "px-2 py-1 font-mono-num font-semibold bg-neutral-950 text-white text-[11px]";
      btnXbp.className = "px-2 py-1 font-mono-num font-semibold bg-white text-neutral-800 hover:bg-neutral-100 text-[11px]";
      hrChart.setOption("xAxisMode", "bv");
    });

    // オーバーレイチェックボックス
    const bindChk = (id, optKey, syncId = null) => {
      const el = document.getElementById(id);
      el.addEventListener("change", () => {
        if (syncId) document.getElementById(syncId).checked = el.checked;
        hrChart.setOption(optKey, el.checked);
      });
    };

    bindChk("chk-overlay-isochrone", "showIsochrone", "chk-step3-isochrone");
    bindChk("chk-overlay-multi-iso", "showMultiIsochrones");
    bindChk("chk-overlay-radius", "showRadiusLines");
    bindChk("chk-overlay-regions", "showRegions");
    bindChk("chk-overlay-landmarks", "showLandmarks");

    // インタラクションモード切替 (詳細・ズーム vs 矩形ブラシ)
    const btnInspect = document.getElementById("btn-interact-inspect");
    const btnBrush = document.getElementById("btn-interact-brush");
    btnInspect.addEventListener("click", () => {
      btnInspect.className = "px-2 py-1 font-semibold bg-neutral-950 text-white";
      btnBrush.className = "px-2 py-1 font-semibold bg-white text-neutral-800 hover:bg-neutral-100";
      hrChart.setOption("interactionMode", "inspect");
      updateRegionStats(currentStars, false);
    });
    btnBrush.addEventListener("click", () => {
      btnBrush.className = "px-2 py-1 font-semibold bg-neutral-950 text-white";
      btnInspect.className = "px-2 py-1 font-semibold bg-white text-neutral-800 hover:bg-neutral-100";
      hrChart.setOption("interactionMode", "brush");
    });

    // 視点リセット
    document.getElementById("btn-reset-zoom").addEventListener("click", () => {
      hrChart.resetZoom();
    });

    // 解説モーダル開閉
    const modal = document.getElementById("modal-framework-guide");
    document.getElementById("btn-open-guide").addEventListener("click", () => {
      modal.classList.remove("hidden");
    });
    document.getElementById("btn-close-guide").addEventListener("click", () => {
      modal.classList.add("hidden");
    });
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.classList.add("hidden");
    });
  }

  function setYAxisModeUI(mode) {
    const btnToolbarAbs = document.getElementById("toolbar-y-abs");
    const btnToolbarApp = document.getElementById("toolbar-y-app");
    const btnStep1Abs = document.getElementById("btn-mode-absolute");
    const btnStep1App = document.getElementById("btn-mode-apparent");

    if (mode === "absolute") {
      btnToolbarAbs.className = "px-2 py-1 font-semibold bg-neutral-950 text-white text-[11px]";
      btnToolbarApp.className = "px-2 py-1 font-semibold bg-white text-neutral-800 hover:bg-neutral-100 text-[11px]";
      btnStep1Abs.className = "py-1.5 px-2 text-xs font-semibold border border-neutral-900 bg-neutral-950 text-white transition";
      btnStep1App.className = "py-1.5 px-2 text-xs font-semibold border border-neutral-900 bg-white text-neutral-900 hover:bg-neutral-100 transition";
    } else {
      btnToolbarApp.className = "px-2 py-1 font-semibold bg-neutral-950 text-white text-[11px]";
      btnToolbarAbs.className = "px-2 py-1 font-semibold bg-white text-neutral-800 hover:bg-neutral-100 text-[11px]";
      btnStep1App.className = "py-1.5 px-2 text-xs font-semibold border border-neutral-900 bg-neutral-950 text-white transition";
      btnStep1Abs.className = "py-1.5 px-2 text-xs font-semibold border border-neutral-900 bg-white text-neutral-900 hover:bg-neutral-100 transition";
    }

    hrChart.setOption("yAxisMode", mode);
  }
})();
