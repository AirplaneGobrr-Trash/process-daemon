console.log("Hello from stdout!");
console.error("Hello from stderr!");

let i = 0;

console.log(JSON.stringify(Bun.env, null, 4))

setInterval(() => {
    console.log("Tick:", ++i);
    if (i === 3) {
        console.error("Simulated error message");
    }
    if (i === 5) {
        console.log("Exiting...");
        process.exit(0); // success exit
    }
}, 500);
