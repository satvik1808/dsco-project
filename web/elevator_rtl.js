// ============================================================================
// elevator_rtl.js
// Cycle-accurate JavaScript copy of the Verilog in rtl/. Each section below
// matches one Verilog module. step() first works out all the combinational
// signals from the current registers, then updates every register at once,
// like the non-blocking (<=) assignments on the rising clock edge.
// scripts/verify.js and scripts/vcd2js.js check this model against the
// Icarus Verilog simulation on every clock cycle.
// Works in the browser (window.ElevatorRTL) and in Node (module.exports).
// ============================================================================
(function (root) {
  'use strict';

  const S_IDLE = 0, S_UP = 1, S_DN = 2, S_DOOR = 3;   // elevator_car.v state codes
  const D_NONE = 0, D_UP = 1, D_DN = 2;               // direction codes
  const N = 8, MASK = 0xff;

  // decoder3to8.v
  const decoder = (en, w) => (en ? 1 << w : 0);
  // floor_masks.v
  const aboveMask = f => (MASK << (f + 1)) & MASK;
  const belowMask = f => (1 << f) - 1;
  // priority_encoder8.v (lowest set bit)
  function priorityEncoder(w) {
    for (let k = 0; k < N; k++) if (w & (1 << k)) return { y: k, valid: 1 };
    return { y: 0, valid: 0 };
  }
  // distance.v
  const distance = (a, b) => (a > b ? a - b : b - a);

  function create(params) {
    const p = Object.assign({ N, TRAVEL_TICKS: 8, DOOR_TICKS: 10 }, params || {});

    const newCar = () => ({ floor: 0, state: S_IDLE, dir: D_NONE, timer: 0, calls: 0 });
    let r;      // registers
    let last;   // combinational signals of the last clock cycle (for the UI)

    function reset() {
      r = {
        cycle: 0,
        cars: [newCar(), newCar()],
        up_pend: 0, up_asgd: 0, up_owner: 0,
        dn_pend: 0, dn_asgd: 0, dn_owner: 0,
      };
      last = null;
    }

    // ---- elevator_car.v, part 1: combinational logic ----
    function carComb(c, upAsg, dnAsg) {
      const here = decoder(1, c.floor);
      const above = aboveMask(c.floor), below = belowMask(c.floor);
      const targets = c.calls | upAsg | dnAsg;
      const callHere = (targets & here) !== 0;
      const callAbove = (targets & above) !== 0;
      const callBelow = (targets & below) !== 0;

      let nextDir;
      if (c.dir === D_UP && callAbove) nextDir = D_UP;
      else if (c.dir === D_DN && callBelow) nextDir = D_DN;
      else if (callAbove) nextDir = D_UP;
      else if (callBelow) nextDir = D_DN;
      else nextDir = D_NONE;

      const doorOpen = c.state === S_DOOR;
      const serveUp = doorOpen ? upAsg & here : 0;
      const serveDn = doorOpen ? dnAsg & here : 0;
      return { here, above, below, targets, callHere, callAbove, callBelow, nextDir, doorOpen, serveUp, serveDn };
    }

    // ---- elevator_car.v, parts 2 and 3: registers ----
    function carNext(c, k, carBtn) {
      const n = Object.assign({}, c);
      n.calls = c.state === S_DOOR ? (c.calls | carBtn) & ~k.here & MASK : c.calls | carBtn;
      switch (c.state) {
        case S_IDLE:
          n.timer = 0;
          if (k.callHere) n.state = S_DOOR;
          else if (k.callAbove) { n.state = S_UP; n.dir = D_UP; }
          else if (k.callBelow) { n.state = S_DN; n.dir = D_DN; }
          else n.dir = D_NONE;
          break;
        case S_UP:
          if (c.timer === 0 && k.callHere) n.state = S_DOOR;
          else if (c.timer === 0 && !k.callAbove) { n.state = S_IDLE; n.dir = D_NONE; }
          else if (c.timer === p.TRAVEL_TICKS - 1) { n.floor = (c.floor + 1) & 7; n.timer = 0; }
          else n.timer = c.timer + 1;
          break;
        case S_DN:
          if (c.timer === 0 && k.callHere) n.state = S_DOOR;
          else if (c.timer === 0 && !k.callBelow) { n.state = S_IDLE; n.dir = D_NONE; }
          else if (c.timer === p.TRAVEL_TICKS - 1) { n.floor = (c.floor - 1) & 7; n.timer = 0; }
          else n.timer = c.timer + 1;
          break;
        case S_DOOR:
          if (c.timer === p.DOOR_TICKS - 1) {
            n.timer = 0;
            if (k.nextDir === D_UP) { n.state = S_UP; n.dir = D_UP; }
            else if (k.nextDir === D_DN) { n.state = S_DN; n.dir = D_DN; }
            else { n.state = S_IDLE; n.dir = D_NONE; }
          } else n.timer = c.timer + 1;
          break;
      }
      return n;
    }

    // calls the dispatcher has given to car i
    const asg = (x, i) => [
      x.up_pend & x.up_asgd & (i ? x.up_owner : ~x.up_owner & MASK),
      x.dn_pend & x.dn_asgd & (i ? x.dn_owner : ~x.dn_owner & MASK),
    ];

    // One rising clock edge. inp = { hall_up, hall_dn, car0, car1 } bit masks (pulses).
    function step(inp) {
      inp = inp || {};
      const hallUp = (inp.hall_up || 0) & MASK, hallDn = (inp.hall_dn || 0) & MASK;
      const carBtn = [(inp.car0 || 0) & MASK, (inp.car1 || 0) & MASK];

      // ---- hall_call_dispatcher.v ----
      const [upAsg0, dnAsg0] = asg(r, 0), [upAsg1, dnAsg1] = asg(r, 1);
      const upAsg = [upAsg0, upAsg1], dnAsg = [dnAsg0, dnAsg1];
      const k = [0, 1].map(i => carComb(r.cars[i], upAsg[i], dnAsg[i]));

      const freeUp = r.up_pend & ~r.up_asgd & MASK, freeDn = r.dn_pend & ~r.dn_asgd & MASK;
      const eu = priorityEncoder(freeUp), ed = priorityEncoder(freeDn);
      const pickValid = eu.valid | ed.valid, pickUp = eu.valid;
      const pickFloor = eu.valid ? eu.y : ed.y;
      const dist = [distance(r.cars[0].floor, pickFloor), distance(r.cars[1].floor, pickFloor)];
      const pickCar1 = dist[1] < dist[0] ? 1 : 0;
      const pickVec = decoder(pickValid, pickFloor);
      const newUp = pickUp ? pickVec : 0, newDn = pickUp ? 0 : pickVec;
      const servedUp = k[0].serveUp | k[1].serveUp, servedDn = k[0].serveDn | k[1].serveDn;

      // ---- every register updates at once (non-blocking) ----
      const n = {
        cycle: r.cycle + 1,
        cars: [0, 1].map(i => carNext(r.cars[i], k[i], carBtn[i])),
        up_pend: (r.up_pend | hallUp) & ~servedUp & MASK,
        dn_pend: (r.dn_pend | hallDn) & ~servedDn & MASK,
        up_asgd: ((r.up_asgd & ~servedUp) | newUp) & MASK,
        dn_asgd: ((r.dn_asgd & ~servedDn) | newDn) & MASK,
        up_owner: pickCar1 ? r.up_owner | newUp : r.up_owner & ~newUp & MASK,
        dn_owner: pickCar1 ? r.dn_owner | newDn : r.dn_owner & ~newDn & MASK,
      };

      // combinational nets of this cycle, named as in the Verilog (tb.dut.*)
      const D = 'tb.dut.u_dispatch.';
      const sig = {
        'tb.hall_up_btn': hallUp, 'tb.hall_dn_btn': hallDn, 'tb.car_btn0': carBtn[0], 'tb.car_btn1': carBtn[1],
        'tb.dut.hall_up_btn': hallUp, 'tb.dut.hall_dn_btn': hallDn, 'tb.dut.car_btn0': carBtn[0], 'tb.dut.car_btn1': carBtn[1],
        [D + 'hall_up_btn']: hallUp, [D + 'hall_dn_btn']: hallDn,
        [D + 'free_up']: freeUp, [D + 'free_dn']: freeDn,
        [D + 'up_floor']: eu.y, [D + 'up_valid']: eu.valid, [D + 'dn_floor']: ed.y, [D + 'dn_valid']: ed.valid,
        [D + 'pick_valid']: pickValid, [D + 'pick_up']: pickUp, [D + 'pick_floor']: pickFloor, [D + 'pick_vec']: pickVec,
        [D + 'dist0']: dist[0], [D + 'dist1']: dist[1], [D + 'pick_car1']: pickCar1,
        [D + 'new_up']: newUp, [D + 'new_dn']: newDn, [D + 'served_up']: servedUp, [D + 'served_dn']: servedDn,
        [D + 'enc_up.w']: freeUp, [D + 'enc_up.y']: eu.y, [D + 'enc_up.valid']: eu.valid,
        [D + 'enc_dn.w']: freeDn, [D + 'enc_dn.y']: ed.y, [D + 'enc_dn.valid']: ed.valid,
        [D + 'd0.b']: pickFloor, [D + 'd0.d']: dist[0], [D + 'd1.b']: pickFloor, [D + 'd1.d']: dist[1],
        [D + 'dec_pick.en']: pickValid, [D + 'dec_pick.w']: pickFloor, [D + 'dec_pick.y']: pickVec,
      };
      for (let i = 0; i < 2; i++) {
        const c = 'tb.dut.u_car' + i + '.', q = k[i];
        Object.assign(sig, {
          [c + 'car_btn']: carBtn[i], [c + 'hall_up_asg']: upAsg[i], [c + 'hall_dn_asg']: dnAsg[i],
          [c + 'here']: q.here, [c + 'above']: q.above, [c + 'below']: q.below, [c + 'targets']: q.targets,
          [c + 'call_here']: +q.callHere, [c + 'call_above']: +q.callAbove, [c + 'call_below']: +q.callBelow,
          [c + 'next_dir']: q.nextDir, [c + 'door_open']: +q.doorOpen,
          [c + 'serve_up']: q.serveUp, [c + 'serve_dn']: q.serveDn,
          [c + 'dec_here.en']: 1, [c + 'dec_here.y']: q.here, [c + 'masks.above']: q.above, [c + 'masks.below']: q.below,
          ['tb.dut.up_asg' + i]: upAsg[i], ['tb.dut.dn_asg' + i]: dnAsg[i],
          [D + 'up_asg' + i]: upAsg[i], [D + 'dn_asg' + i]: dnAsg[i],
          ['tb.dut.serve_up' + i]: q.serveUp, ['tb.dut.serve_dn' + i]: q.serveDn,
          [D + 'serve_up' + i]: q.serveUp, [D + 'serve_dn' + i]: q.serveDn,
          ['tb.dut.next_dir' + i]: q.nextDir,
          ['tb.door' + i]: +q.doorOpen, ['tb.dut.door' + i]: +q.doorOpen,
        });
      }

      last = {
        sig,
        pick: pickValid ? { up: !!pickUp, floor: pickFloor, car: pickCar1, dist } : null,
        served: [0, 1].map(i => ({ up: k[i].serveUp, dn: k[i].serveDn })),
        nextDir: [k[0].nextDir, k[1].nextDir],
      };
      r = n;
      return r;
    }

    // Register values, named as in the Verilog (they change on the rising edge)
    function regSignals(x) {
      const s = {};
      for (const h of ['up_pend', 'up_asgd', 'up_owner', 'dn_pend', 'dn_asgd', 'dn_owner'])
        for (const pre of ['tb.', 'tb.dut.', 'tb.dut.u_dispatch.']) s[pre + h] = x[h];
      for (let i = 0; i < 2; i++) {
        const c = x.cars[i], u = 'tb.dut.u_car' + i + '.';
        s[u + 'floor'] = c.floor; s[u + 'state'] = c.state; s[u + 'dir'] = c.dir;
        s[u + 'timer'] = c.timer; s[u + 'car_calls'] = c.calls;
        for (const pre of ['tb.', 'tb.dut.']) {
          s[pre + 'floor' + i] = c.floor; s[pre + 'state' + i] = c.state; s[pre + 'dir' + i] = c.dir;
          s[pre + 'timer' + i] = c.timer; s[pre + 'calls' + i] = c.calls;
        }
        s['tb.dut.u_dispatch.floor' + i] = c.floor;
        s['tb.dut.u_dispatch.d' + i + '.a'] = c.floor;
        s[u + 'dec_here.w'] = c.floor; s[u + 'masks.floor'] = c.floor;
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
        const [u, d] = asg(r, i);
        return carComb(r.cars[i], u, d).nextDir;
      },
    };
  }

  const api = { create, S_IDLE, S_UP, S_DN, S_DOOR, D_NONE, D_UP, D_DN,
                STATE_NAMES: ['IDLE', 'MOVE_UP', 'MOVE_DN', 'DOOR'],
                DIR_NAMES: ['NONE', 'UP', 'DN'] };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ElevatorRTL = api;
})(typeof window !== 'undefined' ? window : this);
