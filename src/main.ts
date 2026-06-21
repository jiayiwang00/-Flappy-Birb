/**
 * Inside this file you will use the classes and functions from rx.js
 * to add visuals to the svg element in index.html, animate them, and make them interactive.
 *
 * Study and complete the tasks in observable exercises first to get ideas.
 *
 * Course Notes showing Asteroids in FRP: https://tgdwyer.github.io/asteroids/
 *
 * You will be marked on your functional programming style
 * as well as the functionality that you implement.
 *
 * Document your code!
 */

import "./style.css";

import {
    Observable,
    catchError,
    filter,
    fromEvent,
    interval,
    map,
    scan,
    switchMap,
    take,
    merge,
    startWith
} from "rxjs";
import { fromFetch } from "rxjs/fetch";

/** Constants */

const Viewport = {
    CANVAS_WIDTH: 600, // width of the SVG canvas
    CANVAS_HEIGHT: 400, // height of the SVG canvas
} as const;

const Birb = {
    WIDTH: 42, // width of the birb image
    HEIGHT: 30, // height of the birb image
} as const;

const Constants = {
    PIPE_WIDTH: 50, // width of each pipe
    TICK_RATE_MS: 35, // fixed tick duration (simulation step) in milliseconds
    GRAVITY: 1, // acceleration applied to bird velocity each tick
    GROUND: 400, // y-coordinate of the ground
    SEED: 1234, // initial random seed
    JUMP_SPEED: -8, // upward speed when the birb jumps
    PIPE_SPEED_PX_PER_SEC: 100, // horizontal speed (leftwards) of pipes in px/s
} as const;

// ---- Pipe data structures ----
// PipeSpawn describes a scheduled pipe read from CSV, using  gap values and spawn time.
type PipeSpawn = Readonly<{
     gapY: number;  // in [0, 1], the vertical centre position of the gap
     gapH: number;  // in [0, 1], gap height as a fraction of canvas height
     timeMs: number }>; // time to spawn this pipe 、

// Pipe describes a live, on-screen pipe with a position and gap values.
type Pipe = Readonly<{ 
    id: number;  // unique id of this pipe
    x: number;  // current x position of this pipe (in pixels)
    gapY: number;  // in [0, 1], vertical center of the gap
    gapH: number }>; // in [0, 1], height of the gap

/**
 * A random number generator which provides two pure functions
 * `hash` and `scale`. Call `hash` repeatedly to generate the
 * sequence of hashes.
 */
abstract class RNG {
    private static m = 0x80000000; // 2^31
    private static a = 1103515245;
    private static c = 12345;

    public static hash = (seed: number): number =>
        (RNG.a * seed + RNG.c) % RNG.m;

    public static scale = (hash: number): number =>
        (2 * hash) / (RNG.m - 1) - 1; // in [-1, 1]
}

// User input
type Key = "Space" | "KeyP";

// State processing
type State = Readonly<{
    gameEnd: boolean;
    win: boolean;
    paused: boolean;
    position: number, // start in the middle of the canvas
    velocity: number, // initial velocity is 0
    lives: number, // lives: 3 initially
    score: number, // initial score
    highScore: number, // best score in the current browser session
    seed: number, // random seed

    timeMs: number;                      // elapsed time in ms
    spawnQueue: ReadonlyArray<PipeSpawn>;// the pipes need to be spawned
    pipes: ReadonlyArray<Pipe>;          // the pipes currently on screen
    nextPipeId: number;                  // next pipe id to use when spawning a new pipe
    totalPipes: number;
    tickIndex: number; // number of simulation ticks elapsed in this run
    currentRun: ReadonlyArray<number>; // player y position at every tick
    previousRun: ReadonlyArray<number> | null; // most recent completed run
}>;

const initialState: State = {
    gameEnd: false,  // the game starts in a running state
    win: false,
    paused: false,
    position: Viewport.CANVAS_HEIGHT / 2, // start in the middle of the canvas
    velocity: 0, // initial velocity is 0
    lives: 3, // lives: 3 initially
    score: 0, // initial score
    highScore: 0,
    seed: Constants.SEED, // random seed

    timeMs: 0, // elapsed time in ms
    spawnQueue: [], // the pipes need to be spawned
    pipes: [], // the pipes currently on screen
    nextPipeId: 0,// next pipe id to use when spawning a new pipe
    totalPipes: 0,

    tickIndex: 0,
    currentRun: [Viewport.CANVAS_HEIGHT / 2],
    previousRun: null,
};

/**
 * Updates the state by proceeding with one time step.
 *
 * @param s Current state
 * @returns Updated state
 */
const tick = (s: State) => s;

// Rendering (side effects)

/**
 * Brings an SVG element to the foreground.
 * @param elem SVG element to bring to the foreground
 */
const bringToForeground = (elem: SVGElement): void => {
    elem.parentNode?.appendChild(elem);
};

/**
 * Displays a SVG element on the canvas. Brings to foreground.
 * @param elem SVG element to display
 */
const show = (elem: SVGElement): void => {
    elem.setAttribute("visibility", "visible");
    bringToForeground(elem);
};

/**
 * Hides a SVG element on the canvas.
 * @param elem SVG element to hide
 */
const hide = (elem: SVGElement): void => {
    elem.setAttribute("visibility", "hidden");
};

/**
 * Creates an SVG element with the given properties.
 *
 * See https://developer.mozilla.org/en-US/docs/Web/SVG/Element for valid
 * element names and properties.
 *
 * @param namespace Namespace of the SVG element
 * @param name SVGElement name
 * @param props Properties to set on the SVG element
 * @returns SVG element
 */
const createSvgElement = (
    namespace: string | null,
    name: string,
    props: Record<string, string> = {},
): SVGElement => {
    const elem = document.createElementNS(namespace, name) as SVGElement;
    Object.entries(props).forEach(([k, v]) => elem.setAttribute(k, v));
    return elem;
};

/**
 * render: constructs static SVG elements once, and returns a function
 * that updates attributes every time new State arrives.
 */
const render = (): ((s: State) => void) => {
    // Canvas elements
    const gameOver = document.querySelector("#gameOver") as SVGElement;
    // Text fields
    const livesText = document.querySelector("#livesText") as HTMLElement;
    const scoreText = document.querySelector("#scoreText") as HTMLElement;
    const highScoreText = document.querySelector("#highScoreText") as HTMLElement;

    const svg = document.querySelector("#svgCanvas") as SVGSVGElement;

    svg.setAttribute(
        "viewBox",
        `0 0 ${Viewport.CANVAS_WIDTH} ${Viewport.CANVAS_HEIGHT}`,
    );

    // Container group for all pipes. It sits behind both birds.
    const pipesGroup = createSvgElement(svg.namespaceURI, "g", {});
    svg.appendChild(pipesGroup);

    // The most recent run is rendered in its own non-interactive layer.
    const ghostsGroup = createSvgElement(svg.namespaceURI, "g", {
        "pointer-events": "none",
    });
    svg.appendChild(ghostsGroup);

    // Add birb image
    const birdImg = createSvgElement(svg.namespaceURI, "image", {
        href: "assets/birb.png",
        x: `${Viewport.CANVAS_WIDTH * 0.3 - Birb.WIDTH / 2}`,
        y: `${Viewport.CANVAS_HEIGHT / 2 - Birb.HEIGHT / 2}`,
        width: `${Birb.WIDTH}`,
        height: `${Birb.HEIGHT}`,
        class: "player-bird",
    });
    svg.appendChild(birdImg);

    const youWin = createSvgElement(svg.namespaceURI, "text", {
        id: "youWin",
        x: String(Viewport.CANVAS_WIDTH / 2),
        y: String(Viewport.CANVAS_HEIGHT / 2),
        "text-anchor": "middle",
        "dominant-baseline": "middle",
        "font-size": "48",
        fill: "gold",
        visibility: "hidden",
        });
        youWin.textContent = "YOU WIN!";
        svg.appendChild(youWin);

    const pausedText = createSvgElement(svg.namespaceURI, "text", {
        id: "pausedText",
        x: String(Viewport.CANVAS_WIDTH / 2),
        y: String(Viewport.CANVAS_HEIGHT / 2 - 60),
        "text-anchor": "middle",
        "dominant-baseline": "middle",
        "font-size": "42",
        fill: "white",
        visibility: "hidden",
        });
        pausedText.textContent = "PAUSED";
        svg.appendChild(pausedText);

  /**
   * Return a frame renderer: invoked for every emitted State.
   * Updates attributes (bird position, HUD, pipes) based on current state.
   */
  return (s: State) => {
    birdImg.setAttribute("y", `${s.position - Birb.HEIGHT / 2}`); // update bird vertical position

    // Rebuild the lightweight ghost layer from observable state. The replay
    // is visible only while the previous run has a sample for the current
    // tick; the ghost never participates in collision calculations.
    while (ghostsGroup.firstChild) ghostsGroup.removeChild(ghostsGroup.firstChild);
    const ghostY = s.previousRun?.[s.tickIndex];
    if (ghostY !== undefined) {
        const ghostImg = createSvgElement(svg.namespaceURI, "image", {
            href: "assets/birb.png",
            x: `${Viewport.CANVAS_WIDTH * 0.3 - Birb.WIDTH / 2}`,
            y: `${ghostY - Birb.HEIGHT / 2}`,
            width: `${Birb.WIDTH}`,
            height: `${Birb.HEIGHT}`,
            opacity: "0.4",
            class: "ghost-bird",
        });
        ghostsGroup.appendChild(ghostImg);
    }

    // Update text fields
    livesText.innerText = `${s.lives}`;
    scoreText.innerText = `${s.score}`;
    highScoreText.innerText = `${s.highScore}`;
    // the game over / you win / paused text in different states
    if (s.win) {
        show(youWin);
        hide(gameOver);
        hide(pausedText);
    } else if (s.gameEnd) {
        hide(youWin);
        show(gameOver);
        hide(pausedText);
    } else if (s.paused) {
        hide(youWin);
        hide(gameOver);
        show(pausedText);       
    } else {
        hide(youWin);
        hide(gameOver);
        hide(pausedText);
    }

    // Remove previous frame’s pipe rects from the group 
    while (pipesGroup.firstChild) pipesGroup.removeChild(pipesGroup.firstChild);

    // Draw pipes from the s.pipe
    s.pipes.forEach(p => {
      // Calculate the position of the gap
        // y=0  ─────────────── top
        // │ topHeight = 140
        // │
        // │ gap (120px)
        // │
        // │ bottomY y=260 start，bottomHeight = 140
        // y=400 ─────────────── Ground
      const gapYpx = p.gapY * Viewport.CANVAS_HEIGHT; // gap center in pixels
      const gapHpx = p.gapH * Viewport.CANVAS_HEIGHT; // gap height in pixels

      const topHeight = gapYpx - gapHpx / 2; // height of top pipe
      const bottomY = gapYpx + gapHpx / 2; // y-coordinate of bottom pipe top edge
      const bottomHeight = Constants.GROUND - bottomY; // height of bottom pipe

      // Create top and bottom pipe rectangles
      const topRect = createSvgElement(svg.namespaceURI, "rect", {
        x: `${p.x}`,
        y: `0`,
        width: `${Constants.PIPE_WIDTH}`,
        height: `${topHeight}`,
        class: "pipe-body",
      });

      // Create bottom pipe rectangle
      const bottomRect = createSvgElement(svg.namespaceURI, "rect", {
        x: `${p.x}`,
        y: `${bottomY}`,
        width: `${Constants.PIPE_WIDTH}`,
        height: `${bottomHeight}`,
        class: "pipe-body",
      });

      const topCap = createSvgElement(svg.namespaceURI, "rect", {
        x: `${p.x - 4}`,
        y: `${Math.max(0, topHeight - 16)}`,
        width: `${Constants.PIPE_WIDTH + 8}`,
        height: `${Math.min(16, topHeight)}`,
        rx: "3",
        class: "pipe-cap",
      });

      const bottomCap = createSvgElement(svg.namespaceURI, "rect", {
        x: `${p.x - 4}`,
        y: `${bottomY}`,
        width: `${Constants.PIPE_WIDTH + 8}`,
        height: "16",
        rx: "3",
        class: "pipe-cap",
      });

        // Add to pipes to the group
        pipesGroup.appendChild(topRect);
        pipesGroup.appendChild(bottomRect);
        pipesGroup.appendChild(topCap);
        pipesGroup.appendChild(bottomCap);
       });
  };
};


// Parsing the CSV file
/**
 * Parses the CSV content into an array of PipeSpawn objects.
 *
 * @param csv CSV content as a string
 * @returns Array of PipeSpawn objects
 */
const parseMapCsv = (csv: string): ReadonlyArray<PipeSpawn> =>
  csv
    .split("\n")
        .map(line => {
            const [gy, gh, t] = line.split(",");
            const gapY = parseFloat(gy);
            const gapH = parseFloat(gh);
            const timeMs = Math.round(parseFloat(t) * 1000);
            return { gapY, gapH, timeMs };
        })

// Main game state observable
/**
 * Creates the main game state observable.
 * This observable emits the current game state at each time step.
 *
 * @param csvContents Contents of the CSV file defining the pipe spawn schedule
 * @returns Observable emitting the game state
 */
export const state$ = (csvContents: string): Observable<State> => {
    /** User input */
    const key$ = fromEvent<KeyboardEvent>(document, "keypress");
    const fromKey = (keyCode: Key) =>
        key$.pipe(filter(({ code }) => code === keyCode));

// Jump stream: whenever Space is pressed, updated the velocity
    const jump$ = fromKey("Space").pipe(
        map(() => (s: State): State =>
            s.gameEnd || s.paused ? s : { ...s, velocity: Constants.JUMP_SPEED }),
    );

    // Pause stream: whenever P is pressed, toggle paused state
    const pause$ = fromKey("KeyP").pipe(
        map(() => (s: State): State => (s.gameEnd ? s : { ...s, paused: !s.paused })),
    );

    // Determines the rate of time steps, emits a reducer every TICK_RATE_MS 
    const tick$ = interval(Constants.TICK_RATE_MS).pipe(
    map(() => (s: State): State => {
        if (s.gameEnd || s.paused) return s;// if the game has ended or paused, do nothing
        const dt = Constants.TICK_RATE_MS;  // fixed delta time per tick
        const dx = (Constants.PIPE_SPEED_PX_PER_SEC * dt) / 1000;  // horizontal displacement per tick

        // Move existing pipes to the left, remove those that have gone off screen
        const movedPipes = s.pipes
            .map(p => ({ ...p, x: p.x - dx })) // update x for each pipe
            .filter(p => p.x + Constants.PIPE_WIDTH > 0); // keep pipes whose right edge is still visible

        // Spawn new pipes whose time has come
        const newTimeMs = s.timeMs + dt; // The total game time at the end of the current frame
        const dueSpawns = s.spawnQueue.filter(sp => sp.timeMs <= newTimeMs); // pipes ready to spawn now
        const remainQueue = s.spawnQueue.filter(sp => sp.timeMs > newTimeMs); // still waiting

        // Create new pipes at the right edge of the canvas
        const spawnedNow: ReadonlyArray<Pipe> = dueSpawns.map((sp, i) => ({
            id: s.nextPipeId + i,   // assign unique id
            x: Viewport.CANVAS_WIDTH,   // spawn off the right edge
            gapY: sp.gapY,
            gapH: sp.gapH,}));

        // Update id counter and the active pipe list for this frame.
        const nextPipeId = s.nextPipeId + dueSpawns.length; // next id after spawning
        const pipes = movedPipes.concat(spawnedNow); // active pipes = moved + newly spawned

        // --- Scoring: count pipes whose right edge crossed the bird’s x this frame. ---
        // Bird’s horizontal center is fixed at 30% of canvas width.
        const birdCenterX = Viewport.CANVAS_WIDTH * 0.3;

        const crossCount = s.pipes.reduce((acc, p) => {
            const rightBefore = p.x + Constants.PIPE_WIDTH;     // the left edge of pipe
            const rightAfter = rightBefore - dx; // the right edge of pipe
            // If right edge moved from >= bird x to < bird x, the bird just passed the column.                   
            return acc + (rightBefore >= birdCenterX && rightAfter < birdCenterX ? 1 : 0);}, 0);

        const newScore = s.score + crossCount; // increment score
        const allPassed = newScore >= s.totalPipes;

        // The bird bounces collision with the top/bottom surface (I used chatgpt to help debug this function)
        const halfH = Birb.HEIGHT / 2; // half height of birb
        const halfW = Birb.WIDTH / 2; // half width of birb
        const vy = s.velocity + Constants.GRAVITY; // apply gravity to velocity
        const pos = s.position + vy; // new position

        const hitTop = (pos - halfH) <= 0;                  // top of birb hits top of screen
        const hitBottom = (pos + halfH) >= Constants.GROUND;// bottom of birb hits ground
        const birdLeft = birdCenterX - halfW;               // left edge of birb
        const birdRight = birdCenterX + halfW;              // right edge of birb

        // Check for collision with pipes  (I used chatgpt to help debug this function)
        type PipeHit = { kind: "upper" | "lower"; gapTop: number; gapBottom: number } | null;
        const pipeHit: PipeHit = pipes.reduce<PipeHit>((acc, p) => {
            const pipeLeft = p.x, pipeRight = p.x + Constants.PIPE_WIDTH;
            const overlapX = birdRight >= pipeLeft && birdLeft <= pipeRight;
            if (!overlapX) return acc;

            // Check vertical position against gap
            // Convert the gap from the proportional value to pixels
            const gapYpx = p.gapY * Viewport.CANVAS_HEIGHT;
            const gapHpx = p.gapH * Viewport.CANVAS_HEIGHT;
            const gapTop = Math.max(0, gapYpx - gapHpx / 2);
            const gapBottom = Math.min(Constants.GROUND, gapYpx + gapHpx / 2);

            const birdTop = pos - halfH;                        // bird top y
            const birdBottom = pos + halfH;                     // bird bottom y

            // If bird is above the gap top → hits upper pipe; below gap bottom → hits lower pipe.
            return birdTop < gapTop ? { kind: "upper", gapTop, gapBottom }
                : birdBottom > gapBottom ? { kind: "lower", gapTop, gapBottom } : acc;
            }, null);

        // Aggregate collision flags
        const hitPipeUpper = pipeHit?.kind === "upper";
        const hitPipeLower = pipeHit?.kind === "lower";
        const anyCollision = hitTop || hitBottom || hitPipeUpper || hitPipeLower;

        // No collision: just update position and velocity
        if (!anyCollision) {
            const boundedY = Math.max(halfH, Math.min(Constants.GROUND - halfH, pos)); // [halfH, GROUND-halfH]
            const nextState: State = {
                ...s,
                gameEnd: s.gameEnd || allPassed,
                win: allPassed,
                position: boundedY,
                velocity: vy,
                timeMs: newTimeMs,
                spawnQueue: remainQueue,
                pipes,
                nextPipeId,
                score: newScore,
                highScore: Math.max(s.highScore, newScore),
            };
            return {
                ...nextState,
                tickIndex: s.tickIndex + 1,
                currentRun: [...s.currentRun, nextState.position],
            };
        }
  
    // collision: lose a life, bounce off
    const seed1 = RNG.hash(s.seed);
    const randomNum = RNG.scale(seed1);             
    const bounce = 2 * randomNum + 8 ;     //  bounce velocity     
        
    const bounceDown = hitTop || hitPipeUpper; // bounce down if hit top or upper pipe
    // if bird hit the upper pipe，Math.max(pos, pipeHit.gapTop + halfH) bird is below the gap top, make sure the bird is not inside the pipe
    // if bird hit the lower pipe，Math.min(pos, pipeHit.gapBottom - halfH) to make sure the bird is above the gap bottom
    // if bird hit the ground, make sure it is above the ground after bounce
    // if bird hit the top, make sure it is below the top after bounce
    const posAfterGap = pipeHit 
                        ?  (pipeHit.kind === "upper" ? Math.max(pos, pipeHit.gapTop + halfH) : Math.min(pos, pipeHit.gapBottom - halfH))   
                        : (bounceDown ? Math.max(halfH, pos) : Math.min(Constants.GROUND - halfH, pos));

    // boundedY canvas height = 400, ground level = 400,make sure the bird is in between the ground and the top of the screen
    const boundedY = Math.max(halfH, Math.min(Constants.GROUND - halfH, posAfterGap));  //make sure the bird would not flying out of the screen or falling off the ground
    const newVel = bounceDown ? bounce : -bounce;
    const newLives = Math.max(0, s.lives - 1); // lives not below zero

    const nextState: State = {
      ...s,
      position: boundedY,
      velocity: newVel,
      lives: newLives,
      gameEnd: newLives === 0 || s.gameEnd || allPassed, // if no lives left, end the game
      seed: seed1,

      timeMs: newTimeMs,
      spawnQueue: remainQueue,
      pipes,
      nextPipeId,
      score: newScore,
      highScore: Math.max(s.highScore, newScore),
    };
    return {
        ...nextState,
        tickIndex: s.tickIndex + 1,
        currentRun: [...s.currentRun, nextState.position],
    };
  }),
);

// Combine reducer streams: per-tick updates and jump input.
// const reducers$ = merge(tick$, jump$);
const spawnQueue = parseMapCsv(csvContents);
const initialFromCsv: State = {
    ...initialState,
    win: false,
    paused: false,
    timeMs: 0,
    spawnQueue,
    pipes: [],
    nextPipeId: 0,
    tickIndex: 0,
    currentRun: [Viewport.CANVAS_HEIGHT / 2],
    previousRun: null,
    totalPipes: spawnQueue.length - 1,
};

    // Restart is part of the reducer stream, so the completed path remains
    // observable state instead of being hidden in an imperative side store.
    const restart$ = fromEvent<KeyboardEvent>(document, "keydown").pipe(
        filter(e => e.code === "KeyR"),
        map(() => (s: State): State => ({
            ...initialFromCsv,
            previousRun: s.currentRun,
            highScore: Math.max(s.highScore, s.score),
        })),
    );

    return merge(tick$, jump$, pause$, restart$).pipe(
        scan((s, reduce) => reduce(s), initialFromCsv),
        startWith(initialFromCsv),
    );
};

// The following simply runs your main function on window load.  Make sure to leave it in place.
// You should not need to change this, beware if you are.
if (typeof window !== "undefined") {
    const { protocol, hostname, port } = new URL(import.meta.url);
    const baseUrl = `${protocol}//${hostname}${port ? `:${port}` : ""}`;
    const csvUrl = `${baseUrl}/assets/map.csv`;

    // Get the file from URL
    const csv$ = fromFetch(csvUrl).pipe(
        switchMap(response => {
            if (response.ok) {
                return response.text();
            } else {
                throw new Error(`Fetch error: ${response.status}`);
            }
        }),
        catchError(err => {
            console.error("Error fetching the CSV file:", err);
            throw err;
        }),
    );

    // Observable: wait for first user click
    const click$ = fromEvent(document.body, "mousedown").pipe(take(1));

    csv$.pipe(
        switchMap(contents =>
            // On click - start the game
            click$.pipe(switchMap(() => state$(contents))),
        ),
    ).subscribe(render());
}
