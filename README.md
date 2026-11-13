# OrbitLab

An interactive gravity sandbox that runs in the browser. Fling planets and stars with a slingshot, watch them orbit, collide and merge, and play with a few classic scenes from physics.

Plain HTML, CSS and JavaScript on a `<canvas>`. No build step, no dependencies.

## Run it

```bash
cd OrbitLab
python3 -m http.server 8765
```

Then open <http://127.0.0.1:8765>.

## Controls

| Action | How |
| --- | --- |
| Launch a body | Drag on empty space (pull back like a slingshot); a dashed line previews its path |
| Auto-orbit | Turn on with <kbd>O</kbd>, then click to drop the body into a circular orbit around whatever pulls hardest there |
| Pick what to launch | Asteroid, comet, planet, gas giant, star or black hole from the toolbar |
| Pan | Right-drag or Shift-drag |
| Zoom | Scroll |
| Follow and inspect a body | Click it. The inspector shows what it orbits, its eccentricity and its period; <kbd>Del</kbd> removes it |
| Pause / trails / spacetime grid / sound | <kbd>Space</kbd> / <kbd>T</kbd> / <kbd>G</kbd> / <kbd>M</kbd> |
| Follow centre of mass / clear | <kbd>F</kbd> / <kbd>C</kbd> |
| Scenes | <kbd>1</kbd>–<kbd>6</kbd> |
| Speed | <kbd>+</kbd> / <kbd>−</kbd> or the slider |

## Scenes

1. **Solar system:** six planets, a moon, two comets and an asteroid belt that gets stirred up by the gas giant.
2. **Binary star:** two stars in a tight orbit with planets and a debris ring around both.
3. **Figure-8:** the Chenciner–Montgomery solution, where three equal masses chase each other around one figure-of-eight.
4. **Galaxy collision:** two counter-rotating disks of 1,100 stars each pass close and throw out tidal tails.
5. **Black hole:** a black hole with a glowing accretion disk, two stars in orbit and comets falling in.
6. **Sandbox:** one star; build your own system.

## How it works

- **Integrator:** kick-drift-kick leapfrog with 4–32 substeps per frame. It is symplectic, so orbits do not slowly spiral in or out. The HUD shows energy drift, which normally stays around 0.001%.
- **Bodies vs. particles:** massive bodies attract each other with direct O(n²) summation. Galaxy stars and asteroid belts are massless test particles, which only feel the bodies. That keeps thousands of them cheap.
- **Collisions:** perfectly inelastic. Mass and momentum are conserved, and the merged radius grows with the cube root of mass.
- **Shattering:** an impact faster than 1.2× the pair's escape speed sprays short-lived, glowing debris. The debris is massless, so the merge still conserves mass and momentum.
- **Comets:** the ion tail points straight away from the brightest nearby star. The dust tail curves back along the orbit, and both grow longer near the star.
- **Black holes:** these always win a collision, even against a heavier star, and they swallow everything that crosses the event horizon.
- **Spacetime grid:** a "rubber sheet" picture of gravity. Each grid point is pulled toward every mass, with a pull that falls off with distance.
- **Inspector:** uses the two-body orbital elements around whichever heavier body pulls hardest.
- **Sound:** synthesised with the Web Audio API. Impact thumps drop in pitch with mass, and shattering impacts add a noise crunch.
- **Trajectory preview:** while you drag, a throw-away copy of the system is simulated ahead to draw where the new body will go.
- **Softening:** a small softening term keeps forces finite during close encounters.
