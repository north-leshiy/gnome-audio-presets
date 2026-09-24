// Минимальный раннер для gjs-тестов: test() копит кейсы, run() печатает итог
// и выходит с кодом 1 при падениях.
import System from 'system';

const cases = [];

export function test(name, fn) {
    cases.push({name, fn});
}

export function eq(actual, expected, msg = '') {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${msg} expected ${e}, got ${a}`);
}

export function ok(value, msg = 'expected truthy') {
    if (!value)
        throw new Error(msg);
}

export async function run() {
    let failed = 0;
    for (const {name, fn} of cases) {
        try {
            await fn();
            print(`ok   ${name}`);
        } catch (e) {
            failed++;
            print(`FAIL ${name}\n     ${e.message}`);
        }
    }
    print(`${cases.length - failed}/${cases.length} passed`);
    if (failed)
        System.exit(1);
}
