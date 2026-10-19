// ============================================================================
// elevator_rtl.js
// Cycle-accurate JavaScript port of rtl/elevator_coordinator.v.
// Every register and combinational equation maps 1:1 onto the Verilog; step()
// evaluates all combinational logic from the *current* registers and then
// commits the next values at once, like non-blocking assignments on posedge.
// scripts/verify.js checks this model against the Icarus Verilog trace.
// Works in the browser (window.ElevatorRTL) and in Node (module.exports).
// ============================================================================
(function (root) {
  'use strict';

  const S_IDLE = 0, S_UP = 1, S_DN = 2, S_DOOR = 3;
  const D_NONE = 0, D_UP = 1, D_DN = 2;

  function popcount(v) { let c = 0; while (v) { c += v & 1; v >>>= 1; } return c; }

  function create(params) {
    const p = Object.assign({ N: 8, TRAVEL_TICKS: 8, DOOR_TICKS: 10 }, params || {});
    const N = p.N, MASK = (1 << N) - 1;

    const newCar = () => ({ floor: 0, state: S_IDLE, dir: D_NONE, timer: 0, calls: 0 });
    let r;      // registers
    let last;   // combinational signals of the last evaluated cycle (for the UI)

    function reset() {
      r = {
        cycle: 0,
        cars: [newCar(), newCar()],
        up_pend: 0, up_asgd: 0, up_owner: 0,
        dn_pend: 0, dn_asgd: 0, dn_owner: 0,
      };
      last = null;
    }

    // ---- elevator_car.v combinational block ----
    function carComb(c, upAsg, dnAsg, carBtn) {
      const here = 1 << c.floor;
      const targets = c.calls | upAsg | dnAsg;
      const maskBelow = (here - 1) & MASK;
      const maskAbove = ~(maskBelow | here) & MASK;
      const anyAbove = (targets & maskAbove) !== 0;
      const anyBelow = (targets & maskBelow) !== 0;
      const anyHere = (targets & here) !== 0;

      const wantUp = anyAbove || (upAsg & here) !== 0;
      const wantDn = anyBelow || (dnAsg & here) !== 0;
      const nextDir = (c.dir === D_UP && wantUp) ? D_UP :
                      (c.dir === D_DN && wantDn) ? D_DN :
                      wantUp ? D_UP : wantDn ? D_DN : D_NONE;

      const inDoor = c.state === S_DOOR;
      const serveUp = (inDoor && nextDir !== D_DN) ? (upAsg & here) : 0;
      const serveDn = (inDoor && nextDir !== D_UP) ? (dnAsg & here) : 0;
      const serveCar = inDoor && ((c.calls | carBtn) & here) !== 0;
      const serving = serveCar || serveUp !== 0 || serveDn !== 0;

      const stopUp = (here & (c.calls | upAsg)) !== 0 || ((here & dnAsg) !== 0 && !anyAbove);
      const stopDn = (here & (c.calls | dnAsg)) !== 0 || ((here & upAsg) !== 0 && !anyBelow);

      return { here, targets, maskAbove, maskBelow, anyAbove, anyBelow, anyHere, wantUp, wantDn,
               nextDir, inDoor, serveUp, serveDn, serveCar, serving, stopUp, stopDn };
    }

    // ---- elevator_car.v sequential block ----
    function carNext(c, k, carBtn) {
      const n = Object.assign({}, c);
      n.calls = (c.calls | carBtn) & ~(k.inDoor ? k.here : 0) & MASK;
      switch (c.state) {
        case S_IDLE:
          n.timer = 0;
          if (k.anyHere) n.state = S_DOOR;
          else if (k.anyAbove) { n.state = S_UP; n.dir = D_UP; }
          else if (k.anyBelow) { n.state = S_DN; n.dir = D_DN; }
          else n.dir = D_NONE;
          break;
        case S_UP:
          if (c.timer === 0 && k.stopUp) n.state = S_DOOR;
          else if (c.timer === 0 && !k.anyAbove) { n.state = S_IDLE; n.dir = D_NONE; }
          else if (c.timer === p.TRAVEL_TICKS - 1) { n.floor = (c.floor + 1) & (N - 1); n.timer = 0; }
          else n.timer = c.timer + 1;
          break;
        case S_DN:
          if (c.timer === 0 && k.stopDn) n.state = S_DOOR;
          else if (c.timer === 0 && !k.anyBelow) { n.state = S_IDLE; n.dir = D_NONE; }
          else if (c.timer === p.TRAVEL_TICKS - 1) { n.floor = (c.floor - 1) & (N - 1); n.timer = 0; }
          else n.timer = c.timer + 1;
          break;
        case S_DOOR:
          if (k.serving) n.timer = 0;
          else if (c.timer === p.DOOR_TICKS - 1) {
            n.timer = 0;
            if (k.nextDir === D_UP) { n.state = S_UP; n.dir = D_UP; }
            else if (k.nextDir === D_DN) { n.state = S_DN; n.dir = D_DN; }
            else { n.state = S_IDLE; n.dir = D_NONE; }
          } else n.timer = c.timer + 1;
          break;
      }
      return n;
    }

    // ---- hall_call_dispatcher.v cost function ----
    function cost(c, ndir, f, up, load) {
      const dist = Math.abs(c.floor - f);
      const edir = c.state === S_DOOR ? ndir : c.dir;
      let enRoute;
      if (edir === D_NONE) enRoute = true;
      else if (edir === D_UP) enRoute = up && (f > c.floor || (f === c.floor && c.state === S_DOOR));
      else enRoute = !up && (f < c.floor || (f === c.floor && c.state === S_DOOR));
      return (dist + load + (enRoute ? 0 : 2 * N)) & 63;
    }

    // One rising clock edge. inp = { hall_up, hall_dn, car0, car1 } bit masks (pulses).
    function step(inp) {
      inp = inp || {};
      const hallUp = (inp.hall_up || 0) & MASK, hallDn = (inp.hall_dn || 0) & MASK;
      const carBtn = [(inp.car0 || 0) & MASK, (inp.car1 || 0) & MASK];

      // dispatcher -> car assignment vectors
      const upAsg = [r.up_pend & r.up_asgd & ~r.up_owner & MASK, r.up_pend & r.up_asgd & r.up_owner];
      const dnAsg = [r.dn_pend & r.dn_asgd & ~r.dn_owner & MASK, r.dn_pend & r.dn_asgd & r.dn_owner];

      const k = [0, 1].map(i => carComb(r.cars[i], upAsg[i], dnAsg[i], carBtn[i]));

      // priority encoder: lowest unassigned UP call, else lowest unassigned DOWN call
      let pick = null;
      const freeUp = r.up_pend & ~r.up_asgd & MASK, freeDn = r.dn_pend & ~r.dn_asgd & MASK;
      for (let i = 0; i < N && !pick; i++) if (freeUp & (1 << i)) pick = { up: true, floor: i };
      for (let i = 0; i < N && !pick; i++) if (freeDn & (1 << i)) pick = { up: false, floor: i };

      const pf = pick ? pick.floor : 0, pu = pick ? pick.up : false;
      const load = [0, 1].map(i => popcount(r.cars[i].calls | upAsg[i] | dnAsg[i]));
      const costs = [0, 1].map(i => cost(r.cars[i], k[i].nextDir, pf, pu, load[i]));
      const pickCar1 = costs[1] < costs[0];

      const pickVec = pick ? (1 << pf) : 0;
      const newUp = pu ? pickVec : 0, newDn = pu ? 0 : pickVec;
      const servedUp = k[0].serveUp | k[1].serveUp, servedDn = k[0].serveDn | k[1].serveDn;

      // commit (non-blocking)
      const n = {
        cycle: r.cycle + 1,
        cars: [0, 1].map(i => carNext(r.cars[i], k[i], carBtn[i])),
        up_pend: (r.up_pend | hallUp) & ~servedUp & MASK,
        dn_pend: (r.dn_pend | hallDn) & ~servedDn & MASK,
        up_asgd: ((r.up_asgd & ~servedUp) | newUp) & MASK,
        dn_asgd: ((r.dn_asgd & ~servedDn) | newDn) & MASK,
        up_owner: ((r.up_owner & ~newUp) | (pickCar1 ? newUp : 0)) & MASK,
        dn_owner: ((r.dn_owner & ~newDn) | (pickCar1 ? newDn : 0)) & MASK,
      };

      // combinational nets for this cycle, named as in the Verilog hierarchy (tb.dut.*)
      const sig = {
        'tb.hall_up_btn': hallUp, 'tb.hall_dn_btn': hallDn, 'tb.car_btn0': carBtn[0], 'tb.car_btn1': carBtn[1],
        'tb.dut.u_dispatch.pick_valid': pick ? 1 : 0, 'tb.dut.u_dispatch.pick_up': pu ? 1 : 0,
        'tb.dut.u_dispatch.pick_floor': pf, 'tb.dut.u_dispatch.pick_vec': pickVec,
        'tb.dut.u_dispatch.load0': load[0], 'tb.dut.u_dispatch.load1': load[1],
        'tb.dut.u_dispatch.cost0': costs[0], 'tb.dut.u_dispatch.cost1': costs[1],
        'tb.dut.u_dispatch.pick_car1': pickCar1 ? 1 : 0,
        'tb.dut.u_dispatch.new_up': newUp, 'tb.dut.u_dispatch.new_dn': newDn,
        'tb.dut.u_dispatch.served_up': servedUp, 'tb.dut.u_dispatch.served_dn': servedDn,
      };
      for (const pre of ['tb.', 'tb.dut.', 'tb.dut.u_dispatch.']) {
        sig[pre + 'hall_up_btn'] = hallUp; sig[pre + 'hall_dn_btn'] = hallDn;
      }
      sig['tb.dut.car_btn0'] = carBtn[0]; sig['tb.dut.car_btn1'] = carBtn[1];
      for (let i = 0; i < 2; i++) {
        const c = 'tb.dut.u_car' + i + '.', q = k[i];
        Object.assign(sig, {
          [c + 'car_btn']: carBtn[i], [c + 'hall_up_asg']: upAsg[i], [c + 'hall_dn_asg']: dnAsg[i],
          [c + 'here']: q.here, [c + 'targets']: q.targets, [c + 'mask_above']: q.maskAbove, [c + 'mask_below']: q.maskBelow,
          [c + 'any_above']: +q.anyAbove, [c + 'any_below']: +q.anyBelow, [c + 'any_here']: +q.anyHere,
          [c + 'want_up']: +q.wantUp, [c + 'want_dn']: +q.wantDn, [c + 'next_dir']: q.nextDir,
          [c + 'in_door']: +q.inDoor, [c + 'door_open']: +q.inDoor,
          [c + 'serve_up']: q.serveUp, [c + 'serve_dn']: q.serveDn, [c + 'serve_car']: +q.serveCar, [c + 'serving']: +q.serving,
          [c + 'stop_up']: +q.stopUp, [c + 'stop_dn']: +q.stopDn,
        });
        for (const pre of ['tb.dut.', 'tb.dut.u_dispatch.']) {
          sig[pre + 'up_asg' + i] = upAsg[i]; sig[pre + 'dn_asg' + i] = dnAsg[i];
          sig[pre + 'serve_up' + i] = q.serveUp; sig[pre + 'serve_dn' + i] = q.serveDn;
          sig[pre + 'ndir' + i] = q.nextDir;
        }
        sig['tb.door' + i] = +q.inDoor; sig['tb.dut.door' + i] = +q.inDoor;
      }

      last = {
        sig,
        pick: pick ? { up: pu, floor: pf, car: pickCar1 ? 1 : 0, costs, load } : null,
        served: [0, 1].map(i => ({ up: k[i].serveUp, dn: k[i].serveDn, car: k[i].serveCar ? k[i].here : 0 })),
        nextDir: [k[0].nextDir, k[1].nextDir],
      };
      r = n;
      return r;
    }

    // Registered values, named as in the Verilog hierarchy (they change on posedge)
    function regSignals(x) {
      const s = {};
      const hall = ['up_pend', 'up_asgd', 'up_owner', 'dn_pend', 'dn_asgd', 'dn_owner'];
      for (const h of hall) for (const pre of ['tb.', 'tb.dut.', 'tb.dut.u_dispatch.']) s[pre + h] = x[h];
      for (let i = 0; i < 2; i++) {
        const c = x.cars[i], u = 'tb.dut.u_car' + i + '.';
        s[u + 'floor'] = c.floor; s[u + 'state'] = c.state; s[u + 'dir'] = c.dir; s[u + 'timer'] = c.timer; s[u + 'car_calls'] = c.calls;
        for (const pre of ['tb.', 'tb.dut.']) {
          s[pre + 'floor' + i] = c.floor; s[pre + 'state' + i] = c.state; s[pre + 'dir' + i] = c.dir;
          s[pre + 'timer' + i] = c.timer; s[pre + 'calls' + i] = c.calls;
        }
        const d = 'tb.dut.u_dispatch.';
        s[d + 'floor' + i] = c.floor; s[d + 'state' + i] = c.state; s[d + 'dir' + i] = c.dir; s[d + 'calls' + i] = c.calls;
      }
      return s;
    }

    // Load a register snapshot (used by trace replay mode)
    function load(snapshot) { r = JSON.parse(JSON.stringify(snapshot)); last = null; }

    reset();
    return {
      params: p,
      reset, step, load, regSignals,
      get regs() { return r; },
      get last() { return last; },
      // combinational next_dir for display, without clocking
      nextDirOf(i) {
        const upAsg = i ? r.up_pend & r.up_asgd & r.up_owner : r.up_pend & r.up_asgd & ~r.up_owner & MASK;
        const dnAsg = i ? r.dn_pend & r.dn_asgd & r.dn_owner : r.dn_pend & r.dn_asgd & ~r.dn_owner & MASK;
        return carComb(r.cars[i], upAsg, dnAsg, 0).nextDir;
      },
    };
  }

  const api = { create, S_IDLE, S_UP, S_DN, S_DOOR, D_NONE, D_UP, D_DN,
                STATE_NAMES: ['IDLE', 'MOVE_UP', 'MOVE_DN', 'DOOR'],
                DIR_NAMES: ['NONE', 'UP', 'DN'] };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ElevatorRTL = api;
})(typeof window !== 'undefined' ? window : this);
