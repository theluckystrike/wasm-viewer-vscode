;; Sample module for WebAssembly Viewer by Zovo.
;; Compile it with "Compile WAT to WASM" in the editor title bar, or open hello.wasm next to it.
(module $hello
  (import "env" "log" (func $log (param i32 i32)))
  (memory $mem (export "memory") 1)
  (global $calls (mut i32) (i32.const 0))
  (data $greeting (i32.const 16) "Hello from WebAssembly!")

  (table $ops 2 funcref)
  (elem (i32.const 0) $add $mul)

  ;; n! with a loop
  (func $factorial (export "factorial") (param $n i64) (result i64)
    (local $acc i64)
    (local.set $acc (i64.const 1))
    (block $done
      (loop $next
        (br_if $done (i64.le_u (local.get $n) (i64.const 1)))
        (local.set $acc (i64.mul (local.get $acc) (local.get $n)))
        (local.set $n (i64.sub (local.get $n) (i64.const 1)))
        (br $next)))
    (local.get $acc))

  ;; the n-th Fibonacci number, recursive
  (func $fib (export "fib") (param $n i32) (result i32)
    (if (result i32) (i32.lt_u (local.get $n) (i32.const 2))
      (then (local.get $n))
      (else
        (i32.add
          (call $fib (i32.sub (local.get $n) (i32.const 1)))
          (call $fib (i32.sub (local.get $n) (i32.const 2)))))))

  (func $add (param i32 i32) (result i32) (i32.add (local.get 0) (local.get 1)))
  (func $mul (param i32 i32) (result i32) (i32.mul (local.get 0) (local.get 1)))

  ;; calls $add (op 0) or $mul (op 1) through the table
  (func $apply (export "apply") (param $op i32) (param $a i32) (param $b i32) (result i32)
    (global.set $calls (i32.add (global.get $calls) (i32.const 1)))
    (call_indirect $ops (param i32 i32) (result i32) (local.get $a) (local.get $b) (local.get $op)))

  ;; adds four pairs of numbers at once with SIMD
  (func $add4 (export "add4") (param $x v128) (param $y v128) (result v128)
    (i32x4.add (local.get $x) (local.get $y)))

  (func $greet (export "greet")
    (call $log (i32.const 16) (i32.const 23)))
)
