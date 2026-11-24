// 物理常数与默认参数。所有数值只用于定性比较，来源写在注释里。
(function (LP) {
  'use strict';
  const C = {
    // 铜：电阻率 1.72e-8 Ω·m（20 °C）；1 oz = 35 µm → 片电阻 ≈ 0.49 mΩ/□
    CU_RHO: 1.72e-8,
    OZ_UM: 35,
    CU_K: 385,            // W/(m·K)
    FR4_K_INPLANE: 0.8,   // W/(m·K)，FR-4 面内（玻纤方向）典型值
    FR4_K_THROUGH: 0.3,   // W/(m·K)，厚度方向
    FR4_ER: 4.4,
    C0: 299792458,
    VIA_R_OHM: 1e-3,      // 单个 0.3 mm 镀铜过孔约 1 mΩ（量级）
    VIA_MAX_A: 0.5,       // VF-03 默认：单孔电流上限
    H_NATURAL: 10,        // W/(m²·K)，自然对流 + 辐射，每面
    // IPC-2221 线宽公式：I = k·ΔT^0.44·A^0.725（A 单位 mil²），外层 k = 0.048，内层 0.024
    IPC_K_EXT: 0.048,
    IPC_K_INT: 0.024,
    IPC_DT: 10,           // 允许温升 K
    THETA_JB: { qfn: 20, dfn: 30, lga: 40, uson: 40, bga: 15, module: 15, sot: 60, soic: 45, inductor: 40, coin: 30, default: 40 },
    TJ_MAX: 125,          // 默认结温上限 °C
    SENSITIVE_ROLES: ['imu', 'magnetometer', 'barometer', 'microphone', 'optical', 'temp_humidity', 'battery'],
    SENSITIVE_SATS: ['crystal'],
    PLANE_SHAPES: ['qfn', 'dfn', 'lga', 'uson', 'module', 'bga', 'coin'],
  };
  /** 1 oz 铜的片电导（S/□）。 */
  C.sheetG = (oz) => (oz * C.OZ_UM * 1e-6) / C.CU_RHO;
  /** 按 IPC-2221 求通过 I(A) 时的最小线宽（mm）。 */
  C.ipcWidth = (I, oz = 1, internal = false) => {
    if (!(I > 0)) return 0;
    const k = internal ? C.IPC_K_INT : C.IPC_K_EXT;
    const A = Math.pow(I / (k * Math.pow(C.IPC_DT, 0.44)), 1 / 0.725); // mil²
    const tMil = oz * 1.378;
    return (A / tMil) * 0.0254;
  };
  /** 介质中波长（mm），默认按微带的有效介电常数粗取 (εr+1)/2。 */
  C.lambdaMm = (fHz, er = C.FR4_ER) => (C.C0 / (fHz * Math.sqrt((er + 1) / 2))) * 1000;
  LP.vconst = C;
})(globalThis.LP = globalThis.LP || {});
