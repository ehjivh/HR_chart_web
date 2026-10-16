/**
 * ==========================================================================
 * astrophysics.js
 * 天文物理計算エンジン（②物理量への変換 ・ ③HR図からの物理的解釈）
 * ==========================================================================
 */

window.Astrophysics = (function () {
  "use strict";

  // 太陽基準定数 (IAU 2015 / Gaia DR3 基準)
  const SOLAR = {
    M_G: 4.67,        // 太陽のGaia Gバンド絶対等級
    BP_RP: 0.82,      // 太陽の色指数 (G_BP - G_RP)
    B_V: 0.653,       // 太陽の色指数 (B - V)
    T_EFF: 5772,      // 太陽の有効温度 (K)
    AGE_GYR: 4.6,     // 太陽の年齢 (Gyr)
    LIFETIME_GYR: 10.0 // 太陽の主系列寿命 (Gyr)
  };

  /**
   * 1. 年周視差 ϖ (mas) から 距離 d (pc) および 光年 (ly) を算出
   * d [pc] = 1000 / ϖ [mas]
   */
  function calcDistance(parallaxMas) {
    if (!parallaxMas || parallaxMas <= 0) return { pc: null, ly: null };
    const pc = 1000.0 / parallaxMas;
    const ly = pc * 3.26156378;
    return { pc, ly };
  }

  /**
   * 2. 視等級 m と 年周視差 ϖ (mas) から 絶対等級 M を算出
   * 仕様書式: M = m + 5 + 5 * log10(ϖ / 1000)
   */
  function calcAbsoluteMagnitude(apparentMag, parallaxMas) {
    if (apparentMag === null || apparentMag === undefined || !parallaxMas || parallaxMas <= 0) {
      return null;
    }
    return apparentMag + 5.0 + 5.0 * Math.log10(parallaxMas / 1000.0);
  }

  /**
   * 距離モジュラス μ = m - M = -5 - 5 * log10(ϖ / 1000) = 5 * log10(d_pc) - 5
   */
  function calcDistanceModulus(parallaxMas) {
    if (!parallaxMas || parallaxMas <= 0) return null;
    return -5.0 - 5.0 * Math.log10(parallaxMas / 1000.0);
  }

  /**
   * Gaia色指数 (G_BP - G_RP) と ジョンソン (B - V) の相互近似変換
   * Jordi et al. (2010) / Evans et al. (2018) の変換関係に基づく近似
   */
  function bpRpToBV(bpRp) {
    if (bpRp === null || bpRp === undefined || isNaN(bpRp)) return null;
    // 主系列〜巨星にわたる滑らかな単調変換近似
    return 0.78 * bpRp - 0.04 * (bpRp * bpRp) + 0.04;
  }

  function bvToBpRp(bv) {
    if (bv === null || bv === undefined || isNaN(bv)) return null;
    return (bv - 0.04) / 0.75;
  }

  /**
   * 3. 色指数 (G_BP - G_RP) から 有効温度 T_eff (K) を導出
   * 黒体輻射近似 (Ballesteros 2012) と Gaia DR3 経験的補正を組み合わせた連続モデル
   * T_eff = 4600 * (1 / (0.92*(B-V) + 1.7) + 1 / (0.92*(B-V) + 0.62))
   */
  function calcEffectiveTemperature(bpRp) {
    if (bpRp === null || bpRp === undefined || isNaN(bpRp)) return null;
    const clampedBpRp = Math.max(-0.65, Math.min(4.8, bpRp));
    const bv = bpRpToBV(clampedBpRp);
    const term1 = 1.0 / (0.92 * bv + 1.7);
    const term2 = 1.0 / (0.92 * bv + 0.62);
    const teff = 4600.0 * (term1 + term2);
    return Math.max(2200, Math.min(42000, teff));
  }

  /**
   * 有効温度 T_eff (K) から 色指数 (G_BP - G_RP) への逆変換（上軸目盛り・等半径線用）
   */
  function teffToBpRp(teff) {
    // 二分探索で calcEffectiveTemperature の逆関数を精密に求める
    let low = -0.65;
    let high = 4.6;
    for (let i = 0; i < 28; i++) {
      const mid = 0.5 * (low + high);
      const t = calcEffectiveTemperature(mid);
      if (t > teff) {
        low = mid;
      } else {
        high = mid;
      }
    }
    return 0.5 * (low + high);
  }

  /**
   * 4. ボロメトリック補正 BC_G の近似と 光度 L / L_sun の算出
   * L / L_sun = 10^(0.4 * (M_bol,sun - (M_G + BC_G)))
   */
  function calcLuminositySolar(absMagG, teff) {
    if (absMagG === null || absMagG === undefined || !teff) return null;
    // 温度に応じた簡易ボロメトリック補正 BC_G (太陽付近で0、高温・低温端で負)
    const logT = Math.log10(teff / SOLAR.T_EFF);
    const bcG = -2.2 * logT * logT;
    const mBol = absMagG + bcG;
    return Math.pow(10, 0.4 * (SOLAR.M_G - mBol));
  }

  /**
   * 5. シュテファン＝ボルツマン則による恒星半径 R / R_sun の算出
   * L = 4π R^2 σ T^4  =>  R / R_sun = sqrt(L / L_sun) * (T_sun / T_eff)^2
   */
  function calcRadiusSolar(luminositySolar, teff) {
    if (!luminositySolar || luminositySolar <= 0 || !teff || teff <= 0) return null;
    const tRatio = SOLAR.T_EFF / teff;
    return Math.sqrt(luminositySolar) * tRatio * tRatio;
  }

  /**
   * 6. HR図上の位置から恒星の種類（進化段階）を分類
   */
  function classifyStarRegion(bpRp, absMagG, radiusSolar) {
    if (bpRp === null || absMagG === null) {
      return { id: "unknown", nameJa: "未分類", nameEn: "Unclassified", isMainSequence: false };
    }

    // 白色矮星領域: 暗く (M_G > 9.0) かつ 高温〜中温 (BP-RP < 1.15, M_G > 4.5*(BP-RP) + 8.2)
    if (absMagG > 8.5 && bpRp < 1.3 && absMagG > 4.2 * bpRp + 7.5) {
      return {
        id: "white_dwarf",
        nameJa: "白色矮星",
        nameEn: "White Dwarf (WD)",
        isMainSequence: false,
        desc: "核融合を終えた中小質量星の中心核。地球ほどの大きさ（約0.01太陽半径）に太陽並みの質量が凝縮した高密度天体。"
      };
    }

    // 超巨星領域: 極めて明るい (M_G < -4.2、または BP-RP > -0.1 で M_G < -2.4)
    if (absMagG < -4.2 || (bpRp > -0.1 && absMagG < -2.4)) {
      return {
        id: "supergiant",
        nameJa: "超巨星・輝巨星",
        nameEn: "Supergiant / Bright Giant",
        isMainSequence: false,
        desc: "大質量星が進化した姿。半径は太陽の数十倍〜数百倍に達し、極めて高い光度を持つが寿命は数百万年〜数千万年と短い。"
      };
    }

    // 赤色巨星・準巨星領域: 色指数が赤く (BP-RP > 0.75) かつ 主系列より有意に明るい
    const zamsMag = estimateZamsMag(bpRp);
    if (bpRp > 0.72 && absMagG < zamsMag - 1.35 && absMagG < 4.2) {
      if (absMagG < 2.2) {
        return {
          id: "red_giant",
          nameJa: "赤色巨星",
          nameEn: "Red Giant (RGB / RC)",
          isMainSequence: false,
          desc: "中心核の水素を使い果たし、外層が大きく膨張して表面温度が低下した恒星。太陽の10〜100倍程度の半径を持つ。"
        };
      } else {
        return {
          id: "subgiant",
          nameJa: "準巨星",
          nameEn: "Subgiant (SGB)",
          isMainSequence: false,
          desc: "主系列を離脱し、赤色巨星へと膨張・冷却していく過渡期の恒星。"
        };
      }
    }

    // 主系列星（中心核で水素核融合を行っている段階）
    return {
      id: "main_sequence",
      nameJa: "主系列星",
      nameEn: "Main Sequence (MS)",
      isMainSequence: true,
      desc: "中心核で水素からヘリウムへの核融合反応を行い、重力と圧力がつり合って安定して輝く恒星（一生の約9割を過ごす段階）。"
    };
  }

  /**
   * 零歳主系列 (ZAMS) の基準絶対等級 M_G(BP-RP) 近似関数
   */
  function estimateZamsMag(bpRp) {
    if (bpRp < 0.0) {
      return 1.2 + 7.2 * bpRp;
    } else if (bpRp < 0.8) {
      return 1.2 + 4.35 * bpRp;
    } else if (bpRp < 1.8) {
      return 4.68 + 4.2 * (bpRp - 0.8);
    } else {
      return 8.88 + 3.15 * (bpRp - 1.8);
    }
  }

  /**
   * 7. スペクトル型 (O, B, A, F, G, K, M) の判定
   */
  function getSpectralType(teff, regionId) {
    if (regionId === "white_dwarf") return "D (白色矮星)";
    if (!teff) return "-";
    if (teff >= 30000) return "O型";
    if (teff >= 10000) return "B型";
    if (teff >= 7500) return "A型";
    if (teff >= 6000) return "F型";
    if (teff >= 5200) return "G型";
    if (teff >= 3700) return "K型";
    return "M型";
  }

  /**
   * 8. 主系列星の質量 (M / M_sun) と 主系列寿命 (年) の推定
   * 質量-光度関係 (Piecewise Mass-Luminosity Relation: Eker et al. 2018)
   * および 寿命 τ_MS ≈ 10^10 yr * (M / M_sun) / (L / L_sun)
   */
  function estimateMassAndLifetime(luminositySolar, regionId) {
    if (!luminositySolar || luminositySolar <= 0) return { massSolar: null, lifetimeYears: null, note: "-" };

    if (regionId === "white_dwarf") {
      return {
        massSolar: 0.60, // 典型的な白色矮星質量 (~0.6 M_sun)
        lifetimeYears: null,
        note: "核融合終了（余熱による冷却段階）"
      };
    }

    if (regionId === "red_giant" || regionId === "subgiant" || regionId === "supergiant") {
      // 巨星は光度が高いが質量は 1〜8 M_sun 程度が多い
      const approxMass = regionId === "supergiant"
        ? Math.min(25, Math.max(8, Math.pow(luminositySolar, 0.22)))
        : Math.min(4.0, Math.max(0.9, Math.pow(luminositySolar, 0.16)));
      return {
        massSolar: approxMass,
        lifetimeYears: 1.0e10 * Math.pow(approxMass, -2.5),
        note: "主系列離脱後の進化段階（初期質量からの推定値）"
      };
    }

    // 主系列星: 光度 L/L_sun から 質量 M/M_sun を逆算
    let massSolar;
    if (luminositySolar < 0.03) {
      // 低質量赤色矮星: L ≈ 0.23 * M^2.3
      massSolar = Math.pow(luminositySolar / 0.23, 1.0 / 2.3);
    } else if (luminositySolar < 16.0) {
      // 太陽型〜中質量星: L ≈ M^4.0
      massSolar = Math.pow(luminositySolar, 0.25);
    } else if (luminositySolar < 30000.0) {
      // 高質量星: L ≈ 1.4 * M^3.5
      massSolar = Math.pow(luminositySolar / 1.4, 1.0 / 3.5);
    } else {
      massSolar = Math.pow(luminositySolar / 32000.0, 1.0 / 1.0) * 20.0;
    }

    massSolar = Math.max(0.08, Math.min(60.0, massSolar));

    // 主系列寿命 τ ≈ 10^10 yr * (M / M_sun)^(-2.5) （または M / L に比例）
    const lifetimeYears = 1.0e10 * Math.pow(massSolar, -2.5);

    return {
      massSolar,
      lifetimeYears,
      note: "主系列の質量-光度関係 ($L \\propto M^{3.5\\sim4}$) より算出"
    };
  }

  /**
   * 寿命（年）を人間が読みやすい日本語表記に変換
   */
  function formatTimescaleJa(years) {
    if (!years || !isFinite(years)) return "-";
    if (years >= 1e12) {
      return (years / 1e12).toFixed(2) + " 兆年";
    } else if (years >= 1e8) {
      return (years / 1e8).toFixed(1) + " 億年";
    } else if (years >= 1e4) {
      return Math.round(years / 1e4).toLocaleString() + " 万年";
    }
    return Math.round(years).toLocaleString() + " 年";
  }

  /**
   * 9. 物理的色温度カラー算出（仕様書第3節：物理的色彩の限定使用）
   * 恒星の表面温度 T_eff (K) から黒体輻射に基づくRGBカラーを返す
   * - 高温の星（B・A型など）：青白〜青色のグラデーション
   * - 中温の星（G・K型、太陽周辺）：黄色〜白色
   * - 低温の星（M型赤色巨星など）：オレンジ〜赤色
   */
  function teffToColorHex(teff) {
    if (!teff || isNaN(teff)) return "#d4d4d4";

    // 黒体輻射の色温度アンカーポイント (K -> [R, G, B])
    // 白背景の学術HR図上でも視認性が高く、かつ物理的な色温度変化を忠実に表すパレット
    const stops = [
      { t: 2400, rgb: [235, 75, 38] },   // 低温M型晩期: 深い赤オレンジ
      { t: 3200, rgb: [248, 118, 58] },  // M型赤色矮星・赤色巨星: 赤〜オレンジ
      { t: 4000, rgb: [252, 168, 92] },  // K型晩期: オレンジ
      { t: 4800, rgb: [250, 204, 132] }, // K型早期: 黄オレンジ
      { t: 5772, rgb: [246, 226, 168] }, // G2型（太陽周辺）: 温かみのある黄色〜黄白
      { t: 6800, rgb: [236, 238, 225] }, // F型: 黄白〜白
      { t: 8500, rgb: [208, 224, 255] }, // A型（ベガ・シリウス）: 青白
      { t: 12000, rgb: [162, 194, 255] },// B型晩期: 淡い青
      { t: 22000, rgb: [112, 154, 255] },// B型早期〜O型: 鮮やかな青
      { t: 35000, rgb: [82, 126, 250] }  // O型高温星: 深い青
    ];

    if (teff <= stops[0].t) return rgbToHex(stops[0].rgb);
    if (teff >= stops[stops.length - 1].t) return rgbToHex(stops[stops.length - 1].t ? stops[stops.length - 1].rgb : [82, 126, 250]);

    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      if (teff >= a.t && teff <= b.t) {
        const ratio = (teff - a.t) / (b.t - a.t);
        const r = Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * ratio);
        const g = Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * ratio);
        const bl = Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * ratio);
        return rgbToHex([r, g, bl]);
      }
    }
    return "#e5e5e5";
  }

  function rgbToHex(rgb) {
    return (
      "#" +
      rgb
        .map((v) => {
          const h = Math.max(0, Math.min(255, v)).toString(16);
          return h.length === 1 ? "0" + h : h;
        })
        .join("")
    );
  }

  /**
   * 10. 単一恒星レコードに対してすべての物理量を一括算出して付与する
   */
  function enrichStarRecord(rawStar, index) {
    const m_G = Number(rawStar.m_G ?? rawStar.phot_g_mean_mag ?? rawStar.Gmag);
    const bp_rp = Number(rawStar.bp_rp ?? rawStar["BP-RP"]);
    const parallax = Number(rawStar.parallax ?? rawStar.Plx);
    const catalogTeff = rawStar.teff_gspphot ?? rawStar.Teff ?? null;

    const dist = calcDistance(parallax);
    const distModulus = calcDistanceModulus(parallax);
    const M_G = calcAbsoluteMagnitude(m_G, parallax);
    const bv = bpRpToBV(bp_rp);
    const calcTeff = calcEffectiveTemperature(bp_rp);
    const teff = calcTeff; // 一貫した色指数→有効温度変換を使用（カタログ値は比較用に保持）
    const lumSolar = calcLuminositySolar(M_G, teff);
    const radSolar = calcRadiusSolar(lumSolar, teff);
    const region = classifyStarRegion(bp_rp, M_G, radSolar);
    const specType = getSpectralType(teff, region.id);
    const massLife = estimateMassAndLifetime(lumSolar, region.id);
    const colorHex = teffToColorHex(teff);

    return {
      id: rawStar.id || String(rawStar.source_id || rawStar.Source || `STAR-${index + 1}`),
      name: rawStar.name || null,
      shortName: rawStar.shortName || rawStar.name || null,
      constellationJa: rawStar.constellationJa || null,
      isFirstMag: Boolean(rawStar.isFirstMag),
      ra: rawStar.ra ?? rawStar.RA_ICRS ?? null,
      dec: rawStar.dec ?? rawStar.DE_ICRS ?? null,
      // ① 観測量
      m_G,
      parallax,
      bp_rp,
      bv,
      // ② 算出された物理量
      distancePc: dist.pc,
      distanceLy: dist.ly,
      distanceModulus: distModulus,
      M_G,
      teff,
      catalogTeff: catalogTeff ? Number(catalogTeff) : null,
      luminositySolar: lumSolar,
      radiusSolar: radSolar,
      // ③ 物理的解釈・分類
      regionId: region.id,
      regionNameJa: region.nameJa,
      regionNameEn: region.nameEn,
      regionDesc: region.desc,
      isMainSequence: region.isMainSequence,
      spectralType: specType,
      massSolar: massLife.massSolar,
      lifetimeYears: massLife.lifetimeYears,
      lifetimeTextJa: formatTimescaleJa(massLife.lifetimeYears),
      massNote: massLife.note,
      colorHex,
      isLandmark: Boolean(rawStar.isLandmark)
    };
  }

  /**
   * 11. 理論等年齢線（Isochrone）ジェネレータ
   * log10(Age / yr) を指定すると、主系列〜ターンオフ〜準巨星〜赤色巨星枝の点列を生成する
   * 例:
   * - logAge = 7.3 (20 Myr): 高温・高光度まで主系列が伸びる若い星団
   * - logAge = 8.0 (1億年): プレアデス星団 (M45) にフィット (Turnoff BP-RP ≈ -0.08, M_G ≈ -0.5)
   * - logAge = 8.81 (6.5億年): ヒアデス星団にフィット (Turnoff BP-RP ≈ 0.20, M_G ≈ 1.4)
   * - logAge = 9.60 (40億年): 散開星団 M67 にフィット (Turnoff BP-RP ≈ 0.68, M_G ≈ 3.6)
   * - logAge = 10.0 (100億年): 古い星団 (Turnoff BP-RP ≈ 0.85, M_G ≈ 4.5)
   */
  function generateIsochrone(logAgeYr) {
    const ageYr = Math.pow(10, logAgeYr);
    // ターンオフ質量 M_to / M_sun ≈ (Age / 10^10 yr)^(-1 / 2.5)
    const turnoffMass = Math.pow(ageYr / 1.0e10, -0.4);

    // ターンオフの色指数 BP-RP_to と 絶対等級 M_G,to を PARSEC 太陽金属量モデルにキャリブレーション
    // logAge = 7.0 -> bpRp_to ≈ -0.36, M_to ≈ -3.6
    // logAge = 8.0 -> bpRp_to ≈ -0.07, M_to ≈ -0.4
    // logAge = 8.81 -> bpRp_to ≈ 0.22, M_to ≈ 1.5
    // logAge = 9.60 -> bpRp_to ≈ 0.66, M_to ≈ 3.55
    // logAge = 10.05 -> bpRp_to ≈ 0.88, M_to ≈ 4.5
    const tNorm = (logAgeYr - 7.0) / 3.0; // 0 (10 Myr) to 1 (10 Gyr)
    const bpRpTurnoff = -0.36 + 0.72 * tNorm + 0.50 * Math.pow(tNorm, 1.65);

    const points = [];

    // (A) 主系列の下端（赤色矮星 BP-RP = 3.1）からターンオフ直前まで
    const numMs = 60;
    const maxBpRp = 3.15;
    for (let i = 0; i <= numMs; i++) {
      const frac = i / numMs; // 0 (低温端) -> 1 (ターンオフ)
      const bpRp = maxBpRp - frac * (maxBpRp - bpRpTurnoff);
      let mG = estimateZamsMag(bpRp);

      // ターンオフに近づくにつれて主系列進化によりわずかに明るくなり、やや赤化する効果
      if (frac > 0.68) {
        const hook = (frac - 0.68) / 0.32;
        mG -= 0.75 * Math.pow(hook, 2.1);
      }

      const teff = calcEffectiveTemperature(bpRp);
      points.push({
        bp_rp: bpRp,
        M_G: mG,
        teff,
        colorHex: teffToColorHex(teff),
        phase: frac > 0.94 ? "MSTO (主系列離脱点)" : "主系列 (MS)"
      });
    }

    // ターンオフポイントを記録
    const turnoffPoint = {
      bp_rp: points[points.length - 1].bp_rp,
      M_G: points[points.length - 1].M_G,
      teff: points[points.length - 1].teff,
      turnoffMassSolar: turnoffMass,
      ageYears: ageYr,
      ageTextJa: formatTimescaleJa(ageYr),
      logAgeYr
    };

    // (B) 準巨星枝 (SGB) から 赤色巨星枝 (RGB) の進化トラック
    // 若い星団 (logAge < 8.3) は高光度で水平に赤色超巨星へ移動、古い星団はSGBを経てRGBを駆け上がる
    const sgbEndBpRp = Math.max(bpRpTurnoff + 0.35, Math.min(1.32, 0.98 + 0.12 * tNorm));
    const sgbEndMag = turnoffPoint.M_G - (logAgeYr < 8.5 ? 0.6 : 0.15);

    const numSgb = 16;
    for (let i = 1; i <= numSgb; i++) {
      const s = i / numSgb;
      // 滑らかなS字の準巨星遷移
      const bpRp = turnoffPoint.bp_rp + (sgbEndBpRp - turnoffPoint.bp_rp) * Math.pow(s, 0.85);
      const mG =
        turnoffPoint.M_G +
        (sgbEndMag - turnoffPoint.M_G) * s -
        0.22 * Math.sin(Math.PI * s);
      const teff = calcEffectiveTemperature(bpRp);
      points.push({
        bp_rp: bpRp,
        M_G: mG,
        teff,
        colorHex: teffToColorHex(teff),
        phase: "準巨星枝 (SGB)"
      });
    }

    // (C) 赤色巨星枝 (RGB) の上昇
    const rgbTipMag = Math.min(turnoffPoint.M_G - 1.5, -2.6 + 0.25 * tNorm);
    const rgbTipBpRp = Math.max(sgbEndBpRp + 0.25, 1.68 + 0.18 * tNorm);
    const numRgb = 22;
    for (let i = 1; i <= numRgb; i++) {
      const r = i / numRgb;
      const bpRp = sgbEndBpRp + (rgbTipBpRp - sgbEndBpRp) * Math.pow(r, 1.25);
      const mG = sgbEndMag + (rgbTipMag - sgbEndMag) * Math.pow(r, 0.92);
      const teff = calcEffectiveTemperature(bpRp);
      points.push({
        bp_rp: bpRp,
        M_G: mG,
        teff,
        colorHex: teffToColorHex(teff),
        phase: "赤色巨星枝 (RGB)"
      });
    }

    return {
      logAgeYr,
      ageYears: ageYr,
      ageTextJa: formatTimescaleJa(ageYr),
      turnoff: turnoffPoint,
      points
    };
  }

  /**
   * 12. 等半径線（Equal-Radius Contours: R = 0.01, 0.1, 1, 10, 100 R_sun）の生成
   * シュテファン＝ボルツマン則: L / L_sun = (R / R_sun)^2 * (T_eff / T_sun)^4
   */
  function generateEqualRadiusLines() {
    const radii = [
      { r: 0.01, label: "0.01 R☉ (白色矮星サイズ)" },
      { r: 0.1, label: "0.1 R☉ (赤色矮星サイズ)" },
      { r: 1.0, label: "1 R☉ (太陽半径)" },
      { r: 10.0, label: "10 R☉ (赤色巨星サイズ)" },
      { r: 100.0, label: "100 R☉ (超巨星サイズ)" }
    ];

    return radii.map((item) => {
      const pts = [];
      for (let bpRp = -0.55; bpRp <= 3.45; bpRp += 0.1) {
        const teff = calcEffectiveTemperature(bpRp);
        const lum = Math.pow(item.r, 2) * Math.pow(teff / SOLAR.T_EFF, 4);
        const logT = Math.log10(teff / SOLAR.T_EFF);
        const bcG = -2.2 * logT * logT;
        const mBol = SOLAR.M_G - 2.5 * Math.log10(lum);
        const mG = mBol - bcG;
        pts.push({ bp_rp: bpRp, M_G: mG });
      }
      return {
        radiusSolar: item.r,
        label: item.label,
        points: pts
      };
    });
  }

  return {
    SOLAR,
    calcDistance,
    calcAbsoluteMagnitude,
    calcDistanceModulus,
    bpRpToBV,
    bvToBpRp,
    calcEffectiveTemperature,
    teffToBpRp,
    calcLuminositySolar,
    calcRadiusSolar,
    classifyStarRegion,
    estimateZamsMag,
    getSpectralType,
    estimateMassAndLifetime,
    formatTimescaleJa,
    teffToColorHex,
    enrichStarRecord,
    generateIsochrone,
    generateEqualRadiusLines
  };
})();

