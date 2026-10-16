/**
 * ==========================================================================
 * hr-chart.js
 * HTML5 Canvas + D3.js 学術HR図レンダラー（描画・可視化層）
 * - UI・軸・グリッド・選択枠・補助線は白黒モノトーンを厳守
 * - 恒星プロットおよび等年齢線カーブにのみ表面温度に応じた物理的色彩を使用
 * ==========================================================================
 */

window.HRChartRenderer = (function () {
  "use strict";

  class HRChart {
    constructor(containerId, callbacks = {}) {
      this.container = document.getElementById(containerId);
      this.callbacks = callbacks;

      // 表示データ
      this.stars = [];
      this.landmarks = [];
      this.selectedStar = null;
      this.hoveredStar = null;
      this.brushedStars = [];

      // 表示オプション状態
      this.options = {
        yAxisMode: "absolute",      // "absolute" (絶対等級 M_G) | "apparent" (視等級 m_G: ①観測段階の比較用)
        xAxisMode: "bp_rp",         // "bp_rp" (G_BP - G_RP) | "bv" (B - V)
        showIsochrone: true,        // 等年齢線の表示
        logAgeYr: 8.80,             // 等年齢線の log10(Age/yr)
        showMultiIsochrones: false, // 比較用複数等年齢線 (100Myr, 650Myr, 4Gyr, 10Gyr)
        showRadiusLines: true,      // 等半径線 (0.01〜100 R_sun)
        showRegions: true,          // 分類領域（主系列・赤色巨星・超巨星・白色矮星）
        showLandmarks: true,        // 太陽・著名恒星ランドマーク
        interactionMode: "inspect"  // "inspect" (ズーム＆クリック選択) | "brush" (矩形領域選択)
      };

      // アニメーション補間用 (m_G ⇄ M_G 遷移)
      this.yTransitionProgress = 1.0; // 0 = apparent (m_G), 1 = absolute (M_G)
      this.animFrameId = null;

      // 軸ドメイン初期値
      this.defaultXDomain = [-0.65, 3.65];
      this.defaultYDomainAbs = [-5.5, 16.8]; // 上が明るい (-5.5)、下が暗い (+16.8)
      this.defaultYDomainApp = [1.5, 19.5];

      this.margin = { top: 54, right: 64, bottom: 52, left: 62 };
      this.currentTransform = d3.zoomIdentity;

      this.initDOM();
      this.initScales();
      this.initInteractions();
      this.bindResize();
    }

    initDOM() {
      this.container.innerHTML = "";
      this.container.style.position = "relative";
      this.container.style.userSelect = "none";

      // 1. 高解像度 HTML5 Canvas (恒星・等年齢線・等半径線描画用)
      this.canvas = document.createElement("canvas");
      this.canvas.style.position = "absolute";
      this.canvas.style.top = "0";
      this.canvas.style.left = "0";
      this.canvas.style. pointerEvents = "none";
      this.container.appendChild(this.canvas);
      this.ctx = this.canvas.getContext("2d");

      // 2. D3 SVG レイヤー (白黒グリッド・反転軸・スペクトル型ヘッダー・ブラシ・イベント受信用)
      this.svg = d3
        .select(this.container)
        .append("svg")
        .style("position", "absolute")
        .style("top", "0")
        .style("left", "0")
        .style("width", "100%")
        .style("height", "100%")
        .style("overflow", "visible");

      this.gRoot = this.svg.append("g");
      this.gGridX = this.gRoot.append("g").attr("class", "hr-grid");
      this.gGridY = this.gRoot.append("g").attr("class", "hr-grid");
      this.gRegions = this.gRoot.append("g").attr("class", "hr-regions");
      this.gSpecBands = this.gRoot.append("g").attr("class", "hr-spec-bands");

      this.gAxisBottom = this.gRoot.append("g").attr("class", "hr-axis");
      this.gAxisTop = this.gRoot.append("g").attr("class", "hr-axis");
      this.gAxisLeft = this.gRoot.append("g").attr("class", "hr-axis");
      this.gAxisRight = this.gRoot.append("g").attr("class", "hr-axis");

      // 軸タイトル
      this.labelBottom = this.gRoot
        .append("text")
        .attr("text-anchor", "middle")
        .attr("fill", "#0a0a0a")
        .attr("font-size", "12px")
        .attr("font-weight", "600");

      this.labelTop = this.gRoot
        .append("text")
        .attr("text-anchor", "middle")
        .attr("fill", "#0a0a0a")
        .attr("font-size", "11px")
        .attr("font-weight", "600");

      this.labelLeft = this.gRoot
        .append("text")
        .attr("text-anchor", "middle")
        .attr("transform", "rotate(-90)")
        .attr("fill", "#0a0a0a")
        .attr("font-size", "12px")
        .attr("font-weight", "600");

      this.labelRight = this.gRoot
        .append("text")
        .attr("text-anchor", "middle")
        .attr("transform", "rotate(90)")
        .attr("fill", "#0a0a0a")
        .attr("font-size", "11px")
        .attr("font-weight", "600");

      // インタラクションオーバーレイ & ブラシレイヤー
      this.interactionRect = this.gRoot
        .append("rect")
        .attr("fill", "transparent")
        .style("cursor", "crosshair");

      this.gBrush = this.gRoot.append("g").attr("class", "brush").style("display", "none");

      // ホバーツールチップ (厳格な白黒モノトーン)
      this.tooltip = document.createElement("div");
      this.tooltip.className =
        "pointer-events-none absolute z-30 hidden bg-white border border-neutral-900 px-3 py-2 text-xs text-neutral-900 shadow-sm font-mono-num";
      this.tooltip.style.minWidth = "210px";
      this.container.appendChild(this.tooltip);
    }

    initScales() {
      const rect = this.container.getBoundingClientRect();
      this.width = Math.max(360, rect.width || 720);
      this.height = Math.max(360, rect.height || 560);
      this.innerWidth = Math.max(100, this.width - this.margin.left - this.margin.right);
      this.innerHeight = Math.max(100, this.height - this.margin.top - this.margin.bottom);

      const dpr = window.devicePixelRatio || 1;
      this.dpr = dpr;
      this.canvas.width = this.width * dpr;
      this.canvas.height = this.height * dpr;
      this.canvas.style.width = `${this.width}px`;
      this.canvas.style.height = `${this.height}px`;

      this.gRoot.attr("transform", `translate(${this.margin.left},${this.margin.top})`);

      this.xScaleBase = d3.scaleLinear().domain(this.defaultXDomain).range([0, this.innerWidth]);
      const yDom =
        this.options.yAxisMode === "apparent" ? this.defaultYDomainApp : this.defaultYDomainAbs;
      this.yScaleBase = d3.scaleLinear().domain(yDom).range([0, this.innerHeight]);

      this.xScale = this.xScaleBase.copy();
      this.yScale = this.yScaleBase.copy();

      this.interactionRect.attr("width", this.innerWidth).attr("height", this.innerHeight);
    }

    initInteractions() {
      // D3 Zoom
      this.zoom = d3
        .zoom()
        .scaleExtent([0.65, 18])
        .translateExtent([
          [-this.innerWidth * 0.4, -this.innerHeight * 0.4],
          [this.innerWidth * 1.4, this.innerHeight * 1.4]
        ])
        .on("zoom", (event) => {
          this.currentTransform = event.transform;
          this.updateRescaledAxes();
          this.render();
        });

      this.interactionRect.call(this.zoom);

      // マウス移動による最近傍恒星ホバー検出
      this.interactionRect.on("mousemove", (event) => {
        const [mx, my] = d3.pointer(event, this.interactionRect.node());
        const nearest = this.findNearestStar(mx, my, 14);
        if (nearest !== this.hoveredStar) {
          this.hoveredStar = nearest;
          this.renderCanvas();
        }
        if (nearest) {
          this.showTooltip(nearest, mx, my);
        } else {
          this.hideTooltip();
        }
      });

      this.interactionRect.on("mouseleave", () => {
        this.hoveredStar = null;
        this.hideTooltip();
        this.renderCanvas();
      });

      // クリックによる恒星選択（②物理量算出シミュレータ・③物理的解釈へ連動）
      this.interactionRect.on("click", (event) => {
        const [mx, my] = d3.pointer(event, this.interactionRect.node());
        const nearest = this.findNearestStar(mx, my, 16);
        if (nearest) {
          this.selectStar(nearest);
        }
      });

      // 矩形ブラシ選択
      this.brush = d3
        .brush()
        .extent([
          [0, 0],
          [this.innerWidth, this.innerHeight]
        ])
        .on("brush end", (event) => {
          if (!event.selection) {
            this.brushedStars = [];
            if (this.callbacks.onBrushSelect) this.callbacks.onBrushSelect([]);
            this.renderCanvas();
            return;
          }
          const [[x0, y0], [x1, y1]] = event.selection;
          const selected = this.stars.filter((s) => {
            const sx = this.getStarX(s);
            const sy = this.getStarY(s);
            return sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1;
          });
          this.brushedStars = selected;
          if (this.callbacks.onBrushSelect) this.callbacks.onBrushSelect(selected);
          this.renderCanvas();
        });

      this.gBrush.call(this.brush);
    }

    bindResize() {
      window.addEventListener("resize", () => {
        this.initScales();
        this.brush.extent([
          [0, 0],
          [this.innerWidth, this.innerHeight]
        ]);
        this.gBrush.call(this.brush);
        this.updateRescaledAxes();
        this.render();
      });
    }

    setData(stars, landmarks = []) {
      this.stars = stars || [];
      this.landmarks = landmarks || [];
      this.brushedStars = [];
      if (this.stars.length > 0 && !this.selectedStar) {
        this.selectedStar = this.stars[0];
      }
      this.render();
    }

    selectStar(star, triggerCallback = true) {
      this.selectedStar = star;
      this.renderCanvas();
      if (triggerCallback && this.callbacks.onStarSelect && star) {
        this.callbacks.onStarSelect(star);
      }
    }

    setOption(key, value) {
      if (key === "yAxisMode" && this.options.yAxisMode !== value) {
        this.options.yAxisMode = value;
        this.animateYModeTransition(value === "absolute" ? 1.0 : 0.0);
        return;
      }
      this.options[key] = value;

      if (key === "xAxisMode") {
        this.defaultXDomain = value === "bv" ? [-0.4, 2.2] : [-0.65, 3.65];
        this.xScaleBase.domain(this.defaultXDomain);
        this.resetZoom();
        return;
      }

      if (key === "interactionMode") {
        if (value === "brush") {
          this.gBrush.style("display", null);
        } else {
          this.gBrush.style("display", "none");
          this.gBrush.call(this.brush.move, null);
          this.brushedStars = [];
        }
      }

      this.updateRescaledAxes();
      this.render();
    }

    /**
     * ①視等級 m_G (距離補正前) ⇄ ②絶対等級 M_G (年周視差による距離補正後) の連続アニメーション
     */
    animateYModeTransition(targetProgress) {
      if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
      const startProgress = this.yTransitionProgress;
      const startTime = performance.now();
      const duration = 650;

      const step = (now) => {
        const t = Math.min(1, (now - startTime) / duration);
        // easeInOutCubic
        const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        this.yTransitionProgress = startProgress + (targetProgress - startProgress) * ease;

        // ドメインも補間
        const d0 =
          this.defaultYDomainApp[0] +
          (this.defaultYDomainAbs[0] - this.defaultYDomainApp[0]) * this.yTransitionProgress;
        const d1 =
          this.defaultYDomainApp[1] +
          (this.defaultYDomainAbs[1] - this.defaultYDomainApp[1]) * this.yTransitionProgress;
        this.yScaleBase.domain([d0, d1]);
        this.updateRescaledAxes();
        this.render();

        if (t < 1) {
          this.animFrameId = requestAnimationFrame(step);
        } else {
          this.animFrameId = null;
        }
      };

      this.animFrameId = requestAnimationFrame(step);
    }

    resetZoom() {
      this.currentTransform = d3.zoomIdentity;
      this.interactionRect.transition().duration(300).call(this.zoom.transform, d3.zoomIdentity);
    }

    updateRescaledAxes() {
      this.xScale = this.currentTransform.rescaleX(this.xScaleBase);
      this.yScale = this.currentTransform.rescaleY(this.yScaleBase);
    }

    getStarColorIndex(star) {
      return this.options.xAxisMode === "bv" ? star.bv : star.bp_rp;
    }

    getStarX(star) {
      const ci = this.getStarColorIndex(star);
      return this.xScale(ci);
    }

    getStarY(star) {
      const yVal =
        star.m_G + (star.M_G - star.m_G) * this.yTransitionProgress;
      return this.yScale(yVal);
    }

    findNearestStar(mx, my, maxDistPx = 14) {
      let best = null;
      let bestDist2 = maxDistPx * maxDistPx;

      // 著名恒星ランドマークも含めて検索
      const pool = this.options.showLandmarks
        ? this.stars.concat(this.landmarks)
        : this.stars;

      for (let i = 0; i < pool.length; i++) {
        const s = pool[i];
        const sx = this.getStarX(s);
        const sy = this.getStarY(s);
        const dx = sx - mx;
        const dy = sy - my;
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestDist2) {
          bestDist2 = d2;
          best = s;
        }
      }
      return best;
    }

    showTooltip(star, mx, my) {
      const title = star.name
        ? `<div class="font-bold border-b border-neutral-300 pb-1 mb-1 flex items-center justify-between">
             <span>${star.name}</span>
             <span class="text-[10px] px-1 border border-neutral-800">${star.spectralType}</span>
           </div>`
        : `<div class="font-bold border-b border-neutral-300 pb-1 mb-1 flex items-center justify-between">
             <span>Gaia DR3 ${String(star.id).slice(0, 12)}</span>
             <span class="text-[10px] px-1 border border-neutral-800">${star.spectralType}</span>
           </div>`;

      this.tooltip.innerHTML = `
        ${title}
        <div class="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px]">
          <span class="text-neutral-500">分類:</span>
          <span class="font-semibold text-right">${star.regionNameJa}</span>
          <span class="text-neutral-500">視等級 m_G:</span>
          <span class="text-right">${star.m_G.toFixed(2)} mag</span>
          <span class="text-neutral-500">年周視差 ϖ:</span>
          <span class="text-right">${star.parallax.toFixed(2)} mas (${star.distancePc ? star.distancePc.toFixed(1) + " pc" : "-"})</span>
          <span class="text-neutral-500">絶対等級 M_G:</span>
          <span class="font-bold text-right">${star.M_G.toFixed(2)} mag</span>
          <span class="text-neutral-500">色指数 BP-RP:</span>
          <span class="text-right">${star.bp_rp.toFixed(2)} mag</span>
          <span class="text-neutral-500">有効温度 T_eff:</span>
          <span class="font-bold text-right">${Math.round(star.teff).toLocaleString()} K</span>
          <span class="text-neutral-500">光度 / 半径:</span>
          <span class="text-right">${this.formatSci(star.luminositySolar)} L☉ / ${this.formatSci(star.radiusSolar)} R☉</span>
        </div>
        <div class="mt-1 pt-1 border-t border-neutral-200 text-[10px] text-neutral-500 text-center">
          クリックで物理量算出プロセスを展開
        </div>
      `;

      this.tooltip.classList.remove("hidden");
      const left = Math.min(
        this.width - 235,
        Math.max(10, this.margin.left + mx + 14)
      );
      const top = Math.min(
        this.height - 175,
        Math.max(10, this.margin.top + my - 20)
      );
      this.tooltip.style.left = `${left}px`;
      this.tooltip.style.top = `${top}px`;
    }

    hideTooltip() {
      this.tooltip.classList.add("hidden");
    }

    formatSci(val) {
      if (!val || !isFinite(val)) return "-";
      if (val >= 0.1 && val < 1000) return val.toFixed(2);
      if (val >= 1000) return val.toExponential(1);
      return val.toExponential(1);
    }

    render() {
      this.renderAxesAndSVG();
      this.renderCanvas();
    }

    /**
     * SVGレイヤー（白黒グリッド・反転軸・有効温度上軸・太陽光度右軸・分類領域）の描画
     */
    renderAxesAndSVG() {
      const w = this.innerWidth;
      const h = this.innerHeight;

      // 1. グリッド線
      const xAxisGrid = d3.axisBottom(this.xScale).ticks(8).tickSize(-h).tickFormat("");
      const yAxisGrid = d3.axisLeft(this.yScale).ticks(9).tickSize(-w).tickFormat("");

      this.gGridX.attr("transform", `translate(0,${h})`).call(xAxisGrid);
      this.gGridY.call(yAxisGrid);

      // 2. 下軸: 色指数 (G_BP - G_RP または B - V)
      const axisBottom = d3.axisBottom(this.xScale).ticks(8).tickSizeInner(-5).tickPadding(8);
      this.gAxisBottom.attr("transform", `translate(0,${h})`).call(axisBottom);

      this.labelBottom
        .attr("x", w / 2)
        .attr("y", h + 38)
        .text(
          this.options.xAxisMode === "bv"
            ? "色指数 B − V [mag]  （← 高温・青  |  低温・赤 →）"
            : "色指数 G_BP − G_RP [mag]  （← 高温・青  |  低温・赤 →）"
        );

      // 3. 左軸: 絶対等級 M_G または 視等級 m_G (反転軸: 上が明るい)
      const axisLeft = d3.axisLeft(this.yScale).ticks(9).tickSizeInner(-5).tickPadding(8);
      this.gAxisLeft.call(axisLeft);

      this.labelLeft
        .attr("x", -h / 2)
        .attr("y", -42)
        .text(
          this.yTransitionProgress > 0.5
            ? "絶対等級 M_G [mag] （10 pc 基準の真の明るさ ↑ 明 / 暗 ↓）"
            : "視等級 m_G [mag] （地球から見た見かけの明るさ ↑ 明 / 暗 ↓）"
        );

      // 4. 上軸: 有効温度 T_eff (K) 目盛り & スペクトル型 (O B A F G K M)
      const tempTicks = [30000, 15000, 10000, 7500, 6000, 5000, 4000, 3200, 2600];
      const xDom = this.xScale.domain();
      const validTempTicks = [];

      tempTicks.forEach((t) => {
        const bpRp = Astrophysics.teffToBpRp(t);
        const ci = this.options.xAxisMode === "bv" ? Astrophysics.bpRpToBV(bpRp) : bpRp;
        if (ci >= Math.min(xDom[0], xDom[1]) && ci <= Math.max(xDom[0], xDom[1])) {
          validTempTicks.push({ teff: t, ci, x: this.xScale(ci) });
        }
      });

      this.gAxisTop.selectAll("*").remove();
      // 上枠線
      this.gAxisTop
        .append("line")
        .attr("x1", 0)
        .attr("x2", w)
        .attr("y1", 0)
        .attr("y2", 0)
        .attr("stroke", "#171717");

      validTempTicks.forEach((tk) => {
        this.gAxisTop
          .append("line")
          .attr("x1", tk.x)
          .attr("x2", tk.x)
          .attr("y1", 0)
          .attr("y2", 5)
          .attr("stroke", "#171717");
        this.gAxisTop
          .append("text")
          .attr("x", tk.x)
          .attr("y", -7)
          .attr("text-anchor", "middle")
          .text(`${tk.teff.toLocaleString()}K`);
      });

      // スペクトル分類バー (O B A F G K M)
      this.gSpecBands.selectAll("*").remove();
      const specBounds = [
        { label: "O / B", tHigh: 40000, tLow: 10000 },
        { label: "A", tHigh: 10000, tLow: 7500 },
        { label: "F", tHigh: 7500, tLow: 6000 },
        { label: "G", tHigh: 6000, tLow: 5200 },
        { label: "K", tHigh: 5200, tLow: 3700 },
        { label: "M", tHigh: 3700, tLow: 2300 }
      ];

      specBounds.forEach((sb) => {
        const ci1 =
          this.options.xAxisMode === "bv"
            ? Astrophysics.bpRpToBV(Astrophysics.teffToBpRp(sb.tHigh))
            : Astrophysics.teffToBpRp(sb.tHigh);
        const ci2 =
          this.options.xAxisMode === "bv"
            ? Astrophysics.bpRpToBV(Astrophysics.teffToBpRp(sb.tLow))
            : Astrophysics.teffToBpRp(sb.tLow);
        const x1 = Math.max(0, Math.min(w, this.xScale(ci1)));
        const x2 = Math.max(0, Math.min(w, this.xScale(ci2)));
        if (x2 - x1 > 22) {
          this.gSpecBands
            .append("text")
            .attr("x", (x1 + x2) / 2)
            .attr("y", 14)
            .attr("text-anchor", "middle")
            .attr("fill", "#525252")
            .attr("font-size", "10px")
            .attr("font-weight", "700")
            .attr("font-family", "JetBrains Mono, monospace")
            .text(sb.label);
        }
      });

      this.labelTop
        .attr("x", w / 2)
        .attr("y", -28)
        .text("有効温度 T_eff [K]  および スペクトル分類 (O・B・A・F・G・K・M)");

      // 5. 右軸: 太陽光度比 L / L_sun (絶対等級モード時)
      this.gAxisRight.selectAll("*").remove();
      this.gAxisRight.attr("transform", `translate(${w},0)`);
      this.gAxisRight
        .append("line")
        .attr("x1", 0)
        .attr("x2", 0)
        .attr("y1", 0)
        .attr("y2", h)
        .attr("stroke", "#171717");

      if (this.yTransitionProgress > 0.5) {
        const logLums = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
        const yDom = this.yScale.domain();
        logLums.forEach((logL) => {
          // M_G ≈ M_G,sun - 2.5 * log10(L / L_sun)
          const mG = Astrophysics.SOLAR.M_G - 2.5 * logL;
          if (mG >= Math.min(yDom[0], yDom[1]) && mG <= Math.max(yDom[0], yDom[1])) {
            const y = this.yScale(mG);
            this.gAxisRight
              .append("line")
              .attr("x1", 0)
              .attr("x2", -5)
              .attr("y1", y)
              .attr("y2", y)
              .attr("stroke", "#171717");
            const labelStr = logL === 0 ? "1 L☉" : `10^${logL}`;
            this.gAxisRight
              .append("text")
              .attr("x", 7)
              .attr("y", y + 3)
              .attr("text-anchor", "start")
              .text(labelStr);
          }
        });
        this.labelRight
          .attr("x", h / 2)
          .attr("y", -w - 48)
          .text("太陽光度比 L / L☉");
      } else {
        this.labelRight.text("");
      }

      // 6. 分類領域ラベル（主系列・赤色巨星・超巨星・白色矮星）のモノトーン表示
      this.gRegions.selectAll("*").remove();
      if (this.options.showRegions && this.yTransitionProgress > 0.7) {
        const regionAnnotations = [
          { label: "超巨星領域 (Supergiants)", bpRp: 0.7, mG: -3.8 },
          { label: "赤色巨星枝 (Red Giants)", bpRp: 1.45, mG: 0.4 },
          { label: "主系列星 (Main Sequence)", bpRp: 0.95, mG: 6.2 },
          { label: "白色矮星領域 (White Dwarfs)", bpRp: 0.15, mG: 12.6 }
        ];

        regionAnnotations.forEach((ra) => {
          const ci =
            this.options.xAxisMode === "bv" ? Astrophysics.bpRpToBV(ra.bpRp) : ra.bpRp;
          const x = this.xScale(ci);
          const y = this.yScale(ra.mG);
          if (x > 20 && x < w - 20 && y > 18 && y < h - 15) {
            const gLabel = this.gRegions
              .append("g")
              .attr("transform", `translate(${x},${y})`);

            gLabel
              .append("rect")
              .attr("x", -84)
              .attr("y", -10)
              .attr("width", 168)
              .attr("height", 18)
              .attr("fill", "rgba(255, 255, 255, 0.84)")
              .attr("stroke", "#525252")
              .attr("stroke-width", 0.8)
              .attr("stroke-dasharray", "2,2");

            gLabel
              .append("text")
              .attr("text-anchor", "middle")
              .attr("y", 2)
              .attr("fill", "#262626")
              .attr("font-size", "10px")
              .attr("font-weight", "600")
              .text(ra.label);
          }
        });
      }
    }

    /**
     * HTML5 Canvasレイヤー（等半径線・恒星プロット・等年齢線カーブ・ランドマーク・選択マーカー）の描画
     */
    renderCanvas() {
      const ctx = this.ctx;
      const dpr = this.dpr;
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.width, this.height);

      // プロット領域でクリップ
      ctx.translate(this.margin.left, this.margin.top);
      ctx.beginPath();
      ctx.rect(0, 0, this.innerWidth, this.innerHeight);
      ctx.clip();

      // 1. 等半径線 (0.01 R_sun 〜 100 R_sun) [白黒モノトーン破線]
      if (this.options.showRadiusLines && this.yTransitionProgress > 0.7) {
        this.drawEqualRadiusLines(ctx);
      }

      // 2. 比較用の背景等年齢線 (100 Myr, 650 Myr, 4 Gyr, 10 Gyr)
      if (this.options.showMultiIsochrones && this.yTransitionProgress > 0.7) {
        const refAges = [8.0, 8.81, 9.6, 10.0];
        refAges.forEach((la) => {
          this.drawIsochroneCurve(ctx, la, false);
        });
      }

      // 3. 恒星散布図プロット（仕様書3節：表面温度に応じた物理的色彩を使用）
      this.drawStarPoints(ctx);

      // 4. メイン等年齢線 (Isochrone) カーブ（物理的色彩＋ターンオフ指標）
      if (this.options.showIsochrone && this.yTransitionProgress > 0.7) {
        this.drawIsochroneCurve(ctx, this.options.logAgeYr, true);
      }

      // 5. 著名恒星・太陽ランドマーク (白黒モノトーンの基準マーカー)
      if (this.options.showLandmarks) {
        this.drawLandmarks(ctx);
      }

      // 6. 選択中・ホバー中の恒星ターゲットリング（白黒モノトーン厳守）
      if (this.selectedStar) {
        this.drawTargetRing(ctx, this.selectedStar, true);
      }
      if (this.hoveredStar && this.hoveredStar !== this.selectedStar) {
        this.drawTargetRing(ctx, this.hoveredStar, false);
      }

      ctx.restore();
    }

    drawEqualRadiusLines(ctx) {
      const lines = Astrophysics.generateEqualRadiusLines();
      ctx.save();
      ctx.strokeStyle = "#a3a3a3";
      ctx.lineWidth = 1.0;
      ctx.setLineDash([4, 4]);

      lines.forEach((line) => {
        ctx.beginPath();
        let started = false;
        line.points.forEach((pt) => {
          const ci =
            this.options.xAxisMode === "bv" ? Astrophysics.bpRpToBV(pt.bp_rp) : pt.bp_rp;
          const x = this.xScale(ci);
          const y = this.yScale(pt.M_G);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        });
        ctx.stroke();

        // ラベルを曲線の中央付近に配置
        const labelPt = line.points[6];
        if (labelPt) {
          const ci =
            this.options.xAxisMode === "bv"
              ? Astrophysics.bpRpToBV(labelPt.bp_rp)
              : labelPt.bp_rp;
          const lx = this.xScale(ci);
          const ly = this.yScale(labelPt.M_G);
          if (lx > 15 && lx < this.innerWidth - 60 && ly > 15 && ly < this.innerHeight - 15) {
            ctx.save();
            ctx.setLineDash([]);
            ctx.font = "10px 'JetBrains Mono', monospace";
            ctx.fillStyle = "#525252";
            ctx.fillText(line.label, lx + 4, ly - 4);
            ctx.restore();
          }
        }
      });

      ctx.restore();
    }

    drawStarPoints(ctx) {
      const hasBrush = this.brushedStars.length > 0;
      const brushedSet = hasBrush ? new Set(this.brushedStars) : null;

      for (let i = 0; i < this.stars.length; i++) {
        const s = this.stars[i];
        const x = this.getStarX(s);
        const y = this.getStarY(s);

        if (x < -10 || x > this.innerWidth + 10 || y < -10 || y > this.innerHeight + 10) {
          continue;
        }

        const isBrushed = !hasBrush || brushedSet.has(s);
        // 絶対等級が明るい星ほどわずかに半径を大きく描画 (2.8px 〜 5.8px)
        const baseRadius = Math.max(2.6, Math.min(5.8, 4.4 - (s.M_G - 5.0) * 0.16));

        ctx.beginPath();
        ctx.arc(x, y, baseRadius, 0, Math.PI * 2);

        // 仕様書第3節：恒星プロットに表面温度に応じた色温度を使用
        ctx.fillStyle = s.colorHex;
        ctx.globalAlpha = isBrushed ? 0.92 : 0.18;
        ctx.fill();

        // 白背景での視認性を高める極細のモノトーン輪郭線
        ctx.lineWidth = isBrushed ? 0.85 : 0.4;
        ctx.strokeStyle = "#171717";
        ctx.stroke();
      }
      ctx.globalAlpha = 1.0;
    }

    drawIsochroneCurve(ctx, logAgeYr, isPrimary) {
      const iso = Astrophysics.generateIsochrone(logAgeYr);
      const pts = iso.points;
      if (pts.length < 2) return;

      ctx.save();

      // 1. 下地の黒ケーシング（白背景上で黄色・白色領域の等年齢線を明瞭にするため）
      ctx.beginPath();
      pts.forEach((pt, idx) => {
        const ci =
          this.options.xAxisMode === "bv" ? Astrophysics.bpRpToBV(pt.bp_rp) : pt.bp_rp;
        const x = this.xScale(ci);
        const y = this.yScale(pt.M_G);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = isPrimary ? "#0a0a0a" : "#737373";
      ctx.lineWidth = isPrimary ? 4.2 : 1.6;
      if (!isPrimary) ctx.setLineDash([3, 3]);
      ctx.stroke();

      // 2. メイン等年齢線: 各セグメントをその有効温度の物理的色彩で描画
      if (isPrimary) {
        ctx.setLineDash([]);
        ctx.lineWidth = 2.4;
        for (let i = 0; i < pts.length - 1; i++) {
          const p1 = pts[i];
          const p2 = pts[i + 1];
          const ci1 =
            this.options.xAxisMode === "bv" ? Astrophysics.bpRpToBV(p1.bp_rp) : p1.bp_rp;
          const ci2 =
            this.options.xAxisMode === "bv" ? Astrophysics.bpRpToBV(p2.bp_rp) : p2.bp_rp;
          ctx.beginPath();
          ctx.moveTo(this.xScale(ci1), this.yScale(p1.M_G));
          ctx.lineTo(this.xScale(ci2), this.yScale(p2.M_G));
          ctx.strokeStyle = p1.colorHex;
          ctx.stroke();
        }

        // ターンオフポイント (MSTO: 主系列離脱点) のモノトーンマーカーと解説ラベル
        const to = iso.turnoff;
        const toCi =
          this.options.xAxisMode === "bv" ? Astrophysics.bpRpToBV(to.bp_rp) : to.bp_rp;
        const tx = this.xScale(toCi);
        const ty = this.yScale(to.M_G);

        if (tx > 5 && tx < this.innerWidth - 5 && ty > 5 && ty < this.innerHeight - 5) {
          ctx.beginPath();
          ctx.arc(tx, ty, 5, 0, Math.PI * 2);
          ctx.fillStyle = "#ffffff";
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = "#0a0a0a";
          ctx.stroke();

          // ラベルボックス
          const labelText = `MSTO (離脱点): 年齢 ${iso.ageTextJa}`;
          ctx.font = "bold 10px 'JetBrains Mono', monospace";
          const tw = ctx.measureText(labelText).width;
          const bx = Math.min(this.innerWidth - tw - 16, Math.max(6, tx - tw - 14));
          const by = Math.max(18, ty - 10);

          ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
          ctx.fillRect(bx - 4, by - 11, tw + 8, 16);
          ctx.strokeStyle = "#0a0a0a";
          ctx.lineWidth = 1;
          ctx.strokeRect(bx - 4, by - 11, tw + 8, 16);

          ctx.fillStyle = "#0a0a0a";
          ctx.fillText(labelText, bx, by);
        }
      } else {
        // 比較用サブ等年齢線の年齢ラベル
        const to = iso.turnoff;
        const toCi =
          this.options.xAxisMode === "bv" ? Astrophysics.bpRpToBV(to.bp_rp) : to.bp_rp;
        const tx = this.xScale(toCi);
        const ty = this.yScale(to.M_G);
        ctx.setLineDash([]);
        ctx.font = "9px 'JetBrains Mono', monospace";
        ctx.fillStyle = "#404040";
        ctx.fillText(`${iso.ageTextJa}`, tx - 28, ty - 6);
      }

      ctx.restore();
    }

    drawLandmarks(ctx) {
      ctx.save();
      this.landmarks.forEach((lm) => {
        const x = this.getStarX(lm);
        const y = this.getStarY(lm);
        if (x < 0 || x > this.innerWidth || y < 0 || y > this.innerHeight) return;

        // ダイヤ型＋物理温度カラーのマーカー
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = lm.colorHex;
        ctx.strokeStyle = "#0a0a0a";
        ctx.lineWidth = 1.4;
        ctx.fillRect(-4.5, -4.5, 9, 9);
        ctx.strokeRect(-4.5, -4.5, 9, 9);
        ctx.restore();

        // モノトーンラベル
        ctx.font = "bold 10px 'Inter', sans-serif";
        ctx.fillStyle = "#0a0a0a";
        ctx.fillText(lm.name, x + 8, y + 3);
      });
      ctx.restore();
    }

    drawTargetRing(ctx, star, isSelected) {
      const x = this.getStarX(star);
      const y = this.getStarY(star);
      if (x < -20 || x > this.innerWidth + 20 || y < -20 || y > this.innerHeight + 20) return;

      ctx.save();
      ctx.strokeStyle = "#0a0a0a";
      ctx.lineWidth = isSelected ? 1.8 : 1.2;

      // 外周リング
      ctx.beginPath();
      ctx.arc(x, y, isSelected ? 10 : 8, 0, Math.PI * 2);
      ctx.stroke();

      // 十字レティクル（学術観測ターゲット風）
      if (isSelected) {
        const rIn = 6;
        const rOut = 14;
        ctx.beginPath();
        ctx.moveTo(x - rOut, y);
        ctx.lineTo(x - rIn, y);
        ctx.moveTo(x + rIn, y);
        ctx.lineTo(x + rOut, y);
        ctx.moveTo(x, y - rOut);
        ctx.lineTo(x, y - rIn);
        ctx.moveTo(x, y + rIn);
        ctx.lineTo(x, y + rOut);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  return { HRChart };
})();

