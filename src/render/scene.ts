// Three.js 渲染层：只读取物理状态并画出来，不参与规则
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { eraserMesh } from './erasers';
import type { Effects } from '../core/sim';
import { TABLE, type EraserDef } from '../core/config';
import type { FallInfo, Snapshot } from '../core/sim';
import { deskEdge, deskTop, flickRing, terrazzo } from './textures';

const DESK_THICK = 0.55;
const FLOOR_Y = -7.5;
const GRAV = 40;

interface FallAnim {
  t: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spinAxis: THREE.Vector3;
  spinRate: number;
  landed: boolean;
  settle: number;
  done: boolean;
}

interface EraserView {
  def: EraserDef;
  mesh: THREE.Object3D;
  mark: THREE.Mesh; // 桌面上的座位色圈
  squash: number;
  fall: FallAnim | null;
  fx: Effects;
}

export class GameScene {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  erasers: EraserView[] = [];
  private raycaster = new THREE.Raycaster();
  private aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.21);
  private trail: THREE.Line;
  private trailPts: THREE.Vector3[] = [];
  private trailFade = 0;
  // 手感反馈
  private power: THREE.Mesh;
  private powerTarget = -1;
  private powerFrac = 0;
  private powerHold = 0; // 出手后定格显示实际力度的剩余秒数
  private shakeAmt = 0;
  private camBase = new THREE.Vector3();
  private crumbs: THREE.InstancedMesh;
  private crumbState: { p: THREE.Vector3; v: THREE.Vector3; r: THREE.Euler; w: THREE.Vector3; life: number; s: number }[] = [];
  private crumbIdx = 0;
  private tmpM = new THREE.Matrix4();
  private tilts = new Map<number, { axis: THREE.Vector3; amp: number; t: number }>();
  private markTex = flickRing();
  portrait = false;

  /** 图形上下文丢失的时刻（0 = 正常）。iPad 切到后台时常会丢失 */
  contextLostAt = 0;
  /** 渲染器重建后通知外部（要重新绑定触摸输入） */
  onRendererRecreated: ((canvas: HTMLCanvasElement) => void) | null = null;

  private createRenderer() {
    const r = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    // 触屏设备用较低的像素比：省显存，也更不容易在后台被系统回收图形上下文
    const touch = matchMedia('(pointer: coarse)').matches;
    r.setPixelRatio(Math.min(window.devicePixelRatio, touch ? 1.5 : 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.domElement.addEventListener('webglcontextlost', () => (this.contextLostAt = performance.now()));
    r.domElement.addEventListener('webglcontextrestored', () => (this.contextLostAt = 0));
    return r;
  }

  /** 丢失后迟迟没恢复：整个换一个新渲染器（贴图会在下次渲染时重新上传） */
  recreateRenderer() {
    const old = this.renderer;
    try {
      old.dispose();
    } catch {}
    old.domElement.remove();
    this.renderer = this.createRenderer();
    this.container.appendChild(this.renderer.domElement);
    this.contextLostAt = 0;
    this.resize();
    this.onRendererRecreated?.(this.renderer.domElement);
  }

  /** 每帧调用：上下文丢失超过 1.5 秒且页面在前台，就重建 */
  checkContext() {
    if (document.visibilityState !== 'visible') return;
    const lost = this.contextLostAt > 0 || this.renderer.getContext().isContextLost();
    if (!lost) return;
    if (!this.contextLostAt) this.contextLostAt = performance.now();
    if (performance.now() - this.contextLostAt > 1500) this.recreateRenderer();
  }

  constructor(private container: HTMLElement) {
    this.renderer = this.createRenderer();
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color('#1c1a17');
    this.scene.fog = new THREE.Fog('#1c1a17', 18, 40);

    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);

    // 灯光：午后从窗户斜射进教室的暖光 + 天光
    const hemi = new THREE.HemisphereLight('#fff2dc', '#4a4038', 0.85);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight('#ffe2b5', 2.3);
    sun.position.set(-7, 14, -5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -10; sc.right = 10; sc.top = 10; sc.bottom = -10; sc.near = 1; sc.far = 40;
    sun.shadow.bias = -0.0004;
    sun.shadow.radius = 4;
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight('#cfe0ff', 0.35);
    fill.position.set(6, 10, 6);
    this.scene.add(fill);

    this.buildDesk();
    this.buildFloor();

    // 手指轨迹（铅笔线）
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 64), 3));
    this.trail = new THREE.Line(tg, new THREE.LineBasicMaterial({ color: '#fff6dd', transparent: true, opacity: 0 }));
    this.trail.frustumCulled = false;
    this.scene.add(this.trail);

    // 力度圈：划动时显示当前手指速度对应的力度
    const pg = new THREE.RingGeometry(1, 1.2, 120, 1, Math.PI / 2, -Math.PI * 2);
    this.power = new THREE.Mesh(pg, new THREE.MeshBasicMaterial({ color: '#3a7d44', transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
    this.power.rotation.x = -Math.PI / 2;
    this.power.position.y = 0.006;
    this.power.visible = false;
    this.scene.add(this.power);

    // 撞击时飞出的橡皮屑
    const N = 90;
    this.crumbs = new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, 0.04, 0.05), new THREE.MeshStandardMaterial({ color: '#e8e2d2', roughness: 0.9 }), N);
    this.crumbs.castShadow = true;
    this.crumbs.frustumCulled = false;
    for (let i = 0; i < N; i++) {
      this.crumbState.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), w: new THREE.Vector3(), life: 0, s: 1 });
      this.tmpM.makeScale(0, 0, 0);
      this.crumbs.setMatrixAt(i, this.tmpM);
    }
    this.scene.add(this.crumbs);

    this.resize();
  }

  /** 力度圈：seat = -1 隐藏；frac 0–1（≥1 为满力） */
  setPower(seat: number, frac: number) {
    if (this.powerHold > 0 && seat < 0) return; // 定格中不被清掉
    this.powerHold = 0;
    this.powerTarget = seat;
    this.powerFrac = Math.max(0, Math.min(1, frac));
  }

  /** 出手后把实际用掉的力度定格显示一会儿 */
  holdPower(seat: number, frac: number, seconds = 0.9) {
    this.powerTarget = seat;
    this.powerFrac = Math.max(0, Math.min(1, frac));
    this.powerHold = seconds;
  }

  shake(amount: number) {
    this.shakeAmt = Math.min(0.35, Math.max(this.shakeAmt, amount));
  }

  /** 撞击点飞出橡皮屑（物理坐标） */
  burst(x: number, y: number, strength: number, color = '#e8e2d2') {
    const n = Math.min(14, Math.round(3 + strength * 10));
    (this.crumbs.material as THREE.MeshStandardMaterial).color.set(color);
    for (let k = 0; k < n; k++) {
      const c = this.crumbState[this.crumbIdx];
      this.crumbIdx = (this.crumbIdx + 1) % this.crumbState.length;
      const a = Math.random() * Math.PI * 2, sp = (0.6 + Math.random() * 1.6) * (0.4 + strength);
      c.p.set(x, 0.25, -y);
      c.v.set(Math.cos(a) * sp, 1.2 + Math.random() * 2.2 * (0.3 + strength), Math.sin(a) * sp);
      c.r.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      c.w.set((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20);
      c.life = 0.7 + Math.random() * 0.5;
      c.s = 0.6 + Math.random() * 0.9;
    }
  }

  /** 被撞时朝撞击方向晃一下（dir 为物理坐标方向） */
  tilt(i: number, dx: number, dy: number, strength: number) {
    const d = Math.hypot(dx, dy) || 1;
    // 绕水平轴转：轴 = 撞击方向 × 竖直
    const axis = new THREE.Vector3(-dy / d, 0, -dx / d);
    this.tilts.set(i, { axis, amp: Math.min(0.32, strength * 0.05), t: 0 });
  }


  private buildDesk() {
    const top = deskTop(136);
    const edge = deskEdge();
    edge.wrapS = THREE.RepeatWrapping;
    edge.repeat.set(4, 1);
    const topMat = new THREE.MeshStandardMaterial({ map: top, roughness: 0.62, metalness: 0, bumpMap: top, bumpScale: 0.6 });
    const edgeMat = new THREE.MeshStandardMaterial({ map: edge, roughness: 0.7 });
    const geo = new RoundedBoxGeometry(TABLE.width, DESK_THICK, TABLE.height, 3, 0.04);
    const desk = new THREE.Mesh(geo, [edgeMat, edgeMat, topMat, edgeMat, edgeMat, edgeMat]);
    desk.position.y = -DESK_THICK / 2;
    desk.receiveShadow = true;
    desk.castShadow = true;
    this.scene.add(desk);

    // 桌肚 + 绿漆铁腿（只在画面边缘露出一点）
    const iron = new THREE.MeshStandardMaterial({ color: '#3f5a46', roughness: 0.55, metalness: 0.4 });
    const box = new THREE.Mesh(new THREE.BoxGeometry(TABLE.width - 0.6, 1.6, TABLE.height - 1.2), new THREE.MeshStandardMaterial({ color: '#5a3a1f', roughness: 0.8 }));
    box.position.set(0, -DESK_THICK - 0.8, 0.3);
    box.castShadow = true;
    this.scene.add(box);
    const legGeo = new THREE.BoxGeometry(0.22, -FLOOR_Y - DESK_THICK, 0.22);
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const leg = new THREE.Mesh(legGeo, iron);
      leg.position.set(x * (TABLE.width / 2 - 0.35), (FLOOR_Y - DESK_THICK) / 2, z * (TABLE.height / 2 - 0.35));
      leg.castShadow = true;
      this.scene.add(leg);
    }
  }

  private buildFloor() {
    const tex = terrazzo();
    tex.repeat.set(10, 10);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.45 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = FLOOR_Y;
    floor.receiveShadow = true;
    this.scene.add(floor);
  }

  setErasers(defs: EraserDef[], colors: string[]) {
    for (const e of this.erasers) {
      this.scene.remove(e.mesh);
      this.scene.remove(e.mark);
    }
    this.erasers = defs.map((def, i) => {
      const mesh = eraserMesh(def);
      this.scene.add(mesh);
      const mark = new THREE.Mesh(
        new THREE.RingGeometry(1, 1.12, 48),
        new THREE.MeshBasicMaterial({ color: colors[i] ?? '#ffffff', transparent: true, opacity: 0.55, depthWrite: false })
      );
      mark.rotation.x = -Math.PI / 2;
      mark.position.y = 0.004;
      const r = Math.hypot(def.w, def.h) / 2 + 0.08;
      mark.scale.setScalar(r);
      this.scene.add(mark);
      return { def, mesh, mark, squash: 0, fall: null, fx: {} };
    });
  }

  setEffects(i: number, fx: Effects) {
    const e = this.erasers[i];
    if (e) e.fx = fx;
  }

  /** 物理坐标 (x, y) → 场景坐标 (x, h, -y) */
  sync(i: number, s: Snapshot) {
    const e = this.erasers[i];
    if (e.fall) return;
    e.mesh.position.set(s.x, e.def.t / 2, -s.y);
    e.mesh.rotation.set(0, s.angle, 0);
    const tl = this.tilts.get(i);
    if (tl) e.mesh.rotateOnWorldAxis(tl.axis, tl.amp * Math.exp(-tl.t * 7) * Math.sin(tl.t * 30));
    e.mark.position.x = s.x;
    e.mark.position.z = -s.y;
  }

  squash(i: number, strength: number) {
    this.erasers[i].squash = Math.min(1, strength);
  }

  startFall(f: FallInfo) {
    const e = this.erasers[f.index];
    // 至少保证一点向外的速度，避免贴着桌沿垂直掉
    const out = new THREE.Vector2(f.pos.x, f.pos.y);
    const ox = Math.abs(f.pos.x) - TABLE.width / 2, oy = Math.abs(f.pos.y) - TABLE.height / 2;
    const dir = ox > oy ? new THREE.Vector2(Math.sign(out.x), 0) : new THREE.Vector2(0, Math.sign(out.y));
    let vx = f.vel.x, vy = f.vel.y;
    const outward = vx * dir.x + vy * dir.y;
    if (outward < 1.2) {
      vx += dir.x * (1.2 - outward);
      vy += dir.y * (1.2 - outward);
    }
    const axis = new THREE.Vector3(dir.y, 0, dir.x).normalize(); // 绕桌沿翻
    e.mark.visible = false;
    e.fall = {
      t: 0,
      pos: new THREE.Vector3(f.pos.x, e.def.t / 2, -f.pos.y),
      vel: new THREE.Vector3(vx, 0, -vy),
      spinAxis: axis,
      spinRate: 6 + Math.hypot(vx, vy) * 0.8,
      landed: false,
      settle: 0,
      done: false,
    };
  }

  /** 是否还有橡皮在下落动画中 */
  anyFalling() {
    return this.erasers.some((e) => e.fall && !e.fall.done);
  }

  // ---------- 输入辅助 ----------
  /** 屏幕坐标 → 物理坐标（与橡皮中层高度的平面求交） */
  screenToTable(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.aimPlane, p)) return null;
    return { x: p.x, y: -p.z };
  }

  trailStart(x: number, y: number) {
    this.trailPts = [new THREE.Vector3(x, 0.02, -y)];
    this.trailFade = 1;
  }
  trailAdd(x: number, y: number) {
    this.trailPts.push(new THREE.Vector3(x, 0.02, -y));
    if (this.trailPts.length > 64) this.trailPts.shift();
    this.trailFade = 1;
  }

  // ---------- 每帧 ----------
  update(dt: number, time: number, render = true) {
    this.checkContext();
    for (const e of this.erasers) {
      // 技能效果：扎根 = 圈变粗变棕，定身 = 圈加深，蓄势 = 圈闪烁
      const mm = e.mark.material as THREE.MeshBasicMaterial;
      const base = Math.hypot(e.def.w, e.def.h) / 2 + 0.08;
      if (e.fx.rooted) {
        mm.opacity = 0.9;
        e.mark.scale.setScalar(base * 1.1);
      } else if (e.fx.braced) {
        mm.opacity = 0.9;
        e.mark.scale.setScalar(base);
      } else if (e.fx.charged) {
        mm.opacity = 0.5 + Math.sin(time * 8) * 0.4;
        e.mark.scale.setScalar(base * (1.05 + Math.sin(time * 8) * 0.05));
      } else {
        mm.opacity = 0.5;
        e.mark.scale.setScalar(base);
      }
      // 击中瞬间压扁
      if (e.squash > 0) {
        e.squash = Math.max(0, e.squash - dt * 6);
        const k = Math.sin(e.squash * Math.PI) * 0.18;
        e.mesh.scale.set(1 + k * 0.3, 1 - k, 1 + k * 0.3);
      } else e.mesh.scale.set(1, 1, 1);

      const f = e.fall;
      if (f && !f.done) {
        f.t += dt;
        if (!f.landed) {
          f.vel.y -= GRAV * dt * (f.t < 0.08 ? 0.3 : 1);
          f.pos.addScaledVector(f.vel, dt);
          e.mesh.position.copy(f.pos);
          const q = new THREE.Quaternion().setFromAxisAngle(f.spinAxis, f.spinRate * dt);
          e.mesh.quaternion.premultiply(q);
          f.vel.x *= 1 - dt * 0.3;
          f.vel.z *= 1 - dt * 0.3;
          if (f.pos.y <= FLOOR_Y + e.def.t / 2) {
            f.landed = true;
            f.pos.y = FLOOR_Y + e.def.t / 2;
            f.vel.multiplyScalar(0.25);
          }
        } else {
          // 落地后躺平，保留朝向
          f.settle = Math.min(1, f.settle + dt * 4);
          f.pos.addScaledVector(f.vel, dt);
          f.vel.multiplyScalar(1 - dt * 5);
          e.mesh.position.copy(f.pos);
          const euler = new THREE.Euler().setFromQuaternion(e.mesh.quaternion, 'YXZ');
          const flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, euler.y, 0, 'YXZ'));
          e.mesh.quaternion.slerp(flat, f.settle);
          if (f.settle >= 1 && f.vel.length() < 0.05) f.done = true;
        }
        if (f.t > 3) f.done = true;
      }
    }

    // 轨迹淡出
    const lm = this.trail.material as THREE.LineBasicMaterial;
    this.trailFade = Math.max(0, this.trailFade - dt * 2.5);
    lm.opacity = this.trailFade * 0.7;
    const pos = this.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < 64; i++) {
      const p = this.trailPts[Math.min(i, this.trailPts.length - 1)];
      if (p) pos.setXYZ(i, p.x, p.y, p.z);
    }
    pos.needsUpdate = true;
    this.trail.geometry.setDrawRange(0, this.trailPts.length);

    for (const [k, tl] of this.tilts) {
      tl.t += dt;
      if (tl.t > 0.8) this.tilts.delete(k);
    }
    // 力度圈
    if (this.powerHold > 0) {
      this.powerHold -= dt;
      if (this.powerHold <= 0) this.powerTarget = -1;
    }
    const pt = this.powerTarget >= 0 ? this.erasers[this.powerTarget] : null;
    if (pt && !pt.fall) {
      const geo = this.power.geometry as THREE.BufferGeometry;
      const total = geo.index!.count;
      const segs = Math.round(this.powerFrac * 120);
      geo.setDrawRange(0, Math.min(total, segs * 6));
      this.power.visible = segs > 0;
      this.power.position.x = pt.mesh.position.x;
      this.power.position.z = pt.mesh.position.z;
      this.power.scale.setScalar(Math.hypot(pt.def.w, pt.def.h) / 2 + 0.32);
      const m = this.power.material as THREE.MeshBasicMaterial;
      m.opacity = this.powerHold > 0 ? Math.min(0.9, this.powerHold * 2) : 0.9;
      m.color.setHSL(0.33 * (1 - this.powerFrac), 0.65, this.powerFrac >= 0.99 ? 0.42 + Math.sin(time * 30) * 0.08 : 0.42);
    } else this.power.visible = false;
    // 橡皮屑
    for (let i = 0; i < this.crumbState.length; i++) {
      const c = this.crumbState[i];
      if (c.life <= 0) continue;
      c.life -= dt;
      c.v.y -= 14 * dt;
      c.p.addScaledVector(c.v, dt);
      const onDesk = Math.abs(c.p.x) < 6 && Math.abs(c.p.z) < 4;
      if (onDesk && c.p.y < 0.02) {
        c.p.y = 0.02;
        c.v.y *= -0.3;
        c.v.x *= 0.6;
        c.v.z *= 0.6;
        c.w.multiplyScalar(0.6);
      }
      c.r.x += c.w.x * dt;
      c.r.y += c.w.y * dt;
      c.r.z += c.w.z * dt;
      const sc = c.life > 0 ? c.s * Math.min(1, c.life * 3) : 0;
      this.tmpM.compose(c.p, new THREE.Quaternion().setFromEuler(c.r), new THREE.Vector3(sc, sc, sc));
      this.crumbs.setMatrixAt(i, this.tmpM);
    }
    this.crumbs.instanceMatrix.needsUpdate = true;
    // 镜头抖动
    if (this.shakeAmt > 0.001) {
      this.camera.position.set(this.camBase.x + (Math.random() - 0.5) * this.shakeAmt, this.camBase.y, this.camBase.z + (Math.random() - 0.5) * this.shakeAmt);
      this.shakeAmt *= Math.exp(-dt * 14);
    } else this.camera.position.copy(this.camBase);

    if (render) this.renderer.render(this.scene, this.camera);
  }

  /** 让桌面恰好铺满屏幕；竖屏时把相机转 90°，桌子长边对齐屏幕长边 */
  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    const aspect = w / h;
    this.portrait = aspect < 1;
    this.camera.aspect = aspect;
    const pad = 0.35;
    const longSide = TABLE.width + pad * 2, shortSide = TABLE.height + pad * 2;
    // 屏幕上的宽/高分别要容纳的桌面尺寸
    const needW = this.portrait ? shortSide : longSide;
    const needH = this.portrait ? longSide : shortSide;
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const visH = Math.max(needH, needW / aspect);
    const dist = visH / 2 / Math.tan(vfov / 2);
    this.camera.position.set(0, dist, 0.0001);
    this.camBase.copy(this.camera.position);
    this.camera.up.set(this.portrait ? -1 : 0, 0, this.portrait ? 0 : -1);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
  }
}
