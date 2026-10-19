#!/bin/sh
# Build + simulate the Verilog, then cross-check the website's JS model against it.
set -e
cd "$(dirname "$0")"
# Windows: default install locations of Node.js and Icarus Verilog
PATH="$PATH:/c/Program Files/nodejs:/c/iverilog/bin"
mkdir -p build

node scripts/gen_stimulus.js "${1:-4000}" "${2:-2026}"
iverilog -g2005 -Wall -o build/sim.vvp \
    -P tb_elevator_coordinator.CYCLES="${1:-4000}" \
    rtl/elevator_car.v rtl/hall_call_dispatcher.v rtl/elevator_coordinator.v \
    tb/tb_elevator_coordinator.v
vvp -n build/sim.vvp
node scripts/verify.js
node scripts/vcd2js.js

echo "Waveform: build/elevator.vcd (open with GTKWave)"
echo "Website:  open web/index.html"
