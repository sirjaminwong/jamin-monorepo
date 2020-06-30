import lodash from "lodash";
import h   from "util"
export function add(a: number, b: number) {
  return lodash.add(a,b);
}

export function multi(a:number,b:number){
  return lodash.multiply(a,b);
}
export function divide(a:number, b:number){
  return a/b;
}
export function minus(a:number,b:number){
  return a-b;
}