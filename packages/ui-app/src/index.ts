import { multi } from "jaminst-ui-lib";
import { cyan } from "chalk";

function main() {
  console.log(multi(1, 3));
  console.log(cyan("app"));
}
main();

export function bar() {
  console.log(bar)
}
