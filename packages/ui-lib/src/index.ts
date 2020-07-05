import { add, multiply } from "lodash";

export function multi(a: number, b: number) {
  console.log(add(a, b));
  return multiply(a, b);
}
export function divide(a: number, b: number) {
  return a / b;
}
export function minus(a: number, b: number) {
  return a - b;
}

export function foo() {
  console.log("foo");
}
