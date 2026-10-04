// 按角色生成橡皮模型
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { EraserDef } from '../core/config';
import { bearFace, elephantTop, puttyTex, rubberTex, type RubberOpts } from './textures';

const cache = new Map<string, THREE.Object3D>();

const std = (map: THREE.Texture, roughness = 0.88) => new THREE.MeshStandardMaterial({ map, roughness, metalness: 0 });

/** 盒子 6 个面（+x, -x, +y顶, -y底, +z, -z）的贴图配置 */
function boxFaces(def: EraserDef): THREE.Material[] {
  const { w, h, t } = def;
  const face = (cw: number, ch: number, extra: Partial<RubberOpts>, base: RubberOpts['base'], seed: number) =>
    std(rubberTex({ cw, ch, base, seed, ...extra }));
  switch (def.skin) {
    case 'white': {
      const b: RubberOpts['base'] = [238, 234, 222];
      const sl = { paper: '#e9e4d2', band: 'rgba(40,70,140,0.85)', from: 0.35, to: 0.92 };
      return [
        face(h, t, {}, b, 11),
        face(h, t, { dirtyEnd: 'left' }, b, 12),
        face(w, h, { dirtyEnd: 'left', sleeve: { ...sl, label: '4B 绘图' } }, b, 13),
        face(w, h, { dirtyEnd: 'left', sleeve: sl }, b, 14),
        face(w, t, { dirtyEnd: 'left', sleeve: sl }, b, 15),
        face(w, t, { dirtyEnd: 'right', sleeve: { ...sl, from: 0.08, to: 0.65 } }, b, 16),
      ];
    }
    case 'elephant': {
      const b: RubberOpts['base'] = [226, 223, 212];
      return [
        face(h, t, { dirtyEnd: 'left' }, b, 31),
        face(h, t, {}, b, 32),
        std(elephantTop(w, h)),
        face(w, h, {}, b, 33),
        face(w, t, { dirtyEnd: 'right' }, b, 34),
        face(w, t, { dirtyEnd: 'left' }, b, 35),
      ];
    }
    case 'sand': {
      const red: RubberOpts['base'] = [206, 92, 90], blue: RubberOpts['base'] = [96, 112, 140];
      const sp = (flip: boolean) => ({ split: { at: 0.55, color: flip ? red : blue, sandy: !flip } });
      return [
        face(h, t, { sandy: true }, blue, 41),
        face(h, t, { dirtyEnd: 'left' }, red, 42),
        face(w, h, { ...sp(false), dirtyEnd: 'left', label: { text: '砂', color: 'rgba(255,240,230,0.55)', x: 0.78 } }, red, 43),
        face(w, h, sp(false), red, 44),
        face(w, t, sp(false), red, 45),
        face(w, t, { split: { at: 0.45, color: red, sandy: false }, sandy: true }, blue, 46),
      ];
    }
    case 'pen': {
      const b: RubberOpts['base'] = [240, 238, 232];
      const sl = { paper: '#2f6a4a', band: 'rgba(230,200,90,0.9)', from: 0.14, to: 1.02 };
      return [
        std(rubberTex({ cw: h, ch: t, base: [47, 106, 74], seed: 51 })),
        face(h, t, { dirtyEnd: 'left' }, b, 52),
        face(w, h, { dirtyEnd: 'left', sleeve: { ...sl, label: 'HB 擦' } }, b, 53),
        face(w, h, { dirtyEnd: 'left', sleeve: sl }, b, 54),
        face(w, t, { dirtyEnd: 'left', sleeve: sl }, b, 55),
        face(w, t, { dirtyEnd: 'right', sleeve: { ...sl, from: -0.02, to: 0.86 } }, b, 56),
      ];
    }
    case 'crumb':
    default: {
      const b: RubberOpts['base'] = [226, 176, 160];
      return [
        face(h, t, { dirtyEnd: 'left' }, b, 61),
        face(h, t, { dirtyEnd: 'right' }, b, 62),
        face(w, h, { dirtyEnd: 'left' }, b, 63),
        face(w, h, {}, b, 64),
        face(w, t, { dirtyEnd: 'left' }, b, 65),
        face(w, t, { dirtyEnd: 'right' }, b, 66),
      ];
    }
  }
}

function build(def: EraserDef): THREE.Object3D {
  const { w, h, t } = def;
  if (def.skin === 'jelly') {
    const mat = new THREE.MeshPhysicalMaterial({
      color: '#b65ccc',
      roughness: 0.22,
      transmission: 0.55,
      thickness: t,
      ior: 1.42,
      clearcoat: 0.8,
      clearcoatRoughness: 0.3,
      attenuationColor: new THREE.Color('#7a2a8e'),
      attenuationDistance: 0.6,
    });
    const m = new THREE.Mesh(new RoundedBoxGeometry(w, t, h, 5, Math.min(0.14, t * 0.4)), mat);
    return m;
  }
  if (def.skin === 'bear') {
    const R = w / 2;
    const g = new THREE.Group();
    const extrude = (r: number, x: number, y: number) => {
      const s = new THREE.Shape();
      s.absarc(x, y, r, 0, Math.PI * 2, false);
      const geo = new THREE.ExtrudeGeometry(s, { depth: t * 0.7, bevelEnabled: true, bevelThickness: t * 0.15, bevelSize: Math.min(0.06, r * 0.15), bevelSegments: 3, curveSegments: 40 });
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, -t / 2 + t * 0.15, 0);
      return geo;
    };
    const faceTex = bearFace(R * 0.86);
    const side = new THREE.MeshStandardMaterial({ color: '#9c6a42', roughness: 0.85 });
    const head = new THREE.Mesh(extrude(R * 0.86, 0, 0), [std(faceTex), side]);
    const earMat = new THREE.MeshStandardMaterial({ color: '#a2704a', roughness: 0.85 });
    // 耳朵朝 +x（角度 0 时脸朝 +x 方向）
    const e1 = new THREE.Mesh(extrude(R * 0.3, R * 0.62, R * 0.58), earMat);
    const e2 = new THREE.Mesh(extrude(R * 0.3, R * 0.62, -R * 0.58), earMat);
    head.rotation.y = -Math.PI / 2;
    g.add(e1, e2, head);
    e1.position.y = e2.position.y = -0.01;
    return g;
  }
  if (def.skin === 'putty') {
    const R = w / 2;
    const geo = new THREE.SphereGeometry(R, 40, 20);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = 1 + 0.08 * Math.sin(v.x * 7.1 + v.z * 3.3) + 0.06 * Math.sin(v.z * 9.7 - v.y * 5) + 0.05 * Math.cos(v.x * 13 + v.y * 4);
      v.multiplyScalar(n);
      v.y = Math.max(v.y * (t / (2 * R)), -t / 2 + 0.005); // 压扁，底部贴桌
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    const tex = puttyTex();
    tex.repeat.set(2, 1);
    return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
  }
  const geo = new RoundedBoxGeometry(w, t, h, 4, Math.min(0.08, t * 0.3, h * 0.25));
  return new THREE.Mesh(geo, boxFaces(def));
}

export function eraserMesh(def: EraserDef): THREE.Object3D {
  const key = `${def.skin}:${def.w.toFixed(3)}:${def.h.toFixed(3)}`;
  let proto = cache.get(key);
  if (!proto) {
    proto = build(def);
    cache.set(key, proto);
  }
  const obj = proto.clone(true);
  obj.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return obj;
}
