'use strict';
// WebAssembly opcode tables: name, immediate kind and, for memory instructions, the natural alignment (log2 bytes).
// Covers the core spec (MVP, sign extension, saturating conversions, bulk memory, reference types, multi-value,
// tail calls, typed function references), fixed-width SIMD and relaxed SIMD, threads (atomics), exception handling
// (legacy try/catch and try_table), multi-memory, memory64 and the GC proposal. Written from the specification.

// Immediate kinds:
// '' none | bt block type | l label | brt br_table | f function | ci call_indirect | t type | lo local | g global
// | tb table | m memarg (align in A) | mi memory index | i32 | i64 | f32 | f64 | ht heap type | sel select types
// | tag | tt try_table | v128 | shuf | lane | ml memarg + lane | d data | e elem | md data+memory | mm memory,memory
// | et elem+table | tt2 table,table | fence | tf type,field | tn type,count | td type,data | te type,elem | t2 type,type
// | rt ref type (non-null) | rtn ref type (nullable) | boc br_on_cast

const ONE = Object.create(null);
function add(code, name, imm = '', align) { ONE[code] = { name, imm, align }; }

add(0x00, 'unreachable'); add(0x01, 'nop'); add(0x02, 'block', 'bt'); add(0x03, 'loop', 'bt'); add(0x04, 'if', 'bt');
add(0x05, 'else'); add(0x06, 'try', 'bt'); add(0x07, 'catch', 'tag'); add(0x08, 'throw', 'tag'); add(0x09, 'rethrow', 'l');
add(0x0a, 'throw_ref'); add(0x0b, 'end'); add(0x0c, 'br', 'l'); add(0x0d, 'br_if', 'l'); add(0x0e, 'br_table', 'brt');
add(0x0f, 'return'); add(0x10, 'call', 'f'); add(0x11, 'call_indirect', 'ci'); add(0x12, 'return_call', 'f');
add(0x13, 'return_call_indirect', 'ci'); add(0x14, 'call_ref', 't'); add(0x15, 'return_call_ref', 't');
add(0x18, 'delegate', 'l'); add(0x19, 'catch_all'); add(0x1a, 'drop'); add(0x1b, 'select'); add(0x1c, 'select', 'sel');
add(0x1f, 'try_table', 'tt');
add(0x20, 'local.get', 'lo'); add(0x21, 'local.set', 'lo'); add(0x22, 'local.tee', 'lo');
add(0x23, 'global.get', 'g'); add(0x24, 'global.set', 'g'); add(0x25, 'table.get', 'tb'); add(0x26, 'table.set', 'tb');
[
  ['i32.load', 2], ['i64.load', 3], ['f32.load', 2], ['f64.load', 3], ['i32.load8_s', 0], ['i32.load8_u', 0],
  ['i32.load16_s', 1], ['i32.load16_u', 1], ['i64.load8_s', 0], ['i64.load8_u', 0], ['i64.load16_s', 1],
  ['i64.load16_u', 1], ['i64.load32_s', 2], ['i64.load32_u', 2], ['i32.store', 2], ['i64.store', 3], ['f32.store', 2],
  ['f64.store', 3], ['i32.store8', 0], ['i32.store16', 1], ['i64.store8', 0], ['i64.store16', 1], ['i64.store32', 2],
].forEach(([n, a], i) => add(0x28 + i, n, 'm', a));
add(0x3f, 'memory.size', 'mi'); add(0x40, 'memory.grow', 'mi');
add(0x41, 'i32.const', 'i32'); add(0x42, 'i64.const', 'i64'); add(0x43, 'f32.const', 'f32'); add(0x44, 'f64.const', 'f64');
const plain = (start, names) => names.split(' ').forEach((n, i) => add(start + i, n));
plain(0x45, 'i32.eqz i32.eq i32.ne i32.lt_s i32.lt_u i32.gt_s i32.gt_u i32.le_s i32.le_u i32.ge_s i32.ge_u');
plain(0x50, 'i64.eqz i64.eq i64.ne i64.lt_s i64.lt_u i64.gt_s i64.gt_u i64.le_s i64.le_u i64.ge_s i64.ge_u');
plain(0x5b, 'f32.eq f32.ne f32.lt f32.gt f32.le f32.ge');
plain(0x61, 'f64.eq f64.ne f64.lt f64.gt f64.le f64.ge');
plain(0x67, 'i32.clz i32.ctz i32.popcnt i32.add i32.sub i32.mul i32.div_s i32.div_u i32.rem_s i32.rem_u i32.and i32.or i32.xor i32.shl i32.shr_s i32.shr_u i32.rotl i32.rotr');
plain(0x79, 'i64.clz i64.ctz i64.popcnt i64.add i64.sub i64.mul i64.div_s i64.div_u i64.rem_s i64.rem_u i64.and i64.or i64.xor i64.shl i64.shr_s i64.shr_u i64.rotl i64.rotr');
plain(0x8b, 'f32.abs f32.neg f32.ceil f32.floor f32.trunc f32.nearest f32.sqrt f32.add f32.sub f32.mul f32.div f32.min f32.max f32.copysign');
plain(0x99, 'f64.abs f64.neg f64.ceil f64.floor f64.trunc f64.nearest f64.sqrt f64.add f64.sub f64.mul f64.div f64.min f64.max f64.copysign');
plain(0xa7, 'i32.wrap_i64 i32.trunc_f32_s i32.trunc_f32_u i32.trunc_f64_s i32.trunc_f64_u i64.extend_i32_s i64.extend_i32_u i64.trunc_f32_s i64.trunc_f32_u i64.trunc_f64_s i64.trunc_f64_u f32.convert_i32_s f32.convert_i32_u f32.convert_i64_s f32.convert_i64_u f32.demote_f64 f64.convert_i32_s f64.convert_i32_u f64.convert_i64_s f64.convert_i64_u f64.promote_f32 i32.reinterpret_f32 i64.reinterpret_f64 f32.reinterpret_i32 f64.reinterpret_i64');
plain(0xc0, 'i32.extend8_s i32.extend16_s i64.extend8_s i64.extend16_s i64.extend32_s');
add(0xd0, 'ref.null', 'ht'); add(0xd1, 'ref.is_null'); add(0xd2, 'ref.func', 'f'); add(0xd3, 'ref.eq');
add(0xd4, 'ref.as_non_null'); add(0xd5, 'br_on_null', 'l'); add(0xd6, 'br_on_non_null', 'l');

// 0xFC prefix
const FC = Object.create(null);
'i32.trunc_sat_f32_s i32.trunc_sat_f32_u i32.trunc_sat_f64_s i32.trunc_sat_f64_u i64.trunc_sat_f32_s i64.trunc_sat_f32_u i64.trunc_sat_f64_s i64.trunc_sat_f64_u'
  .split(' ').forEach((n, i) => { FC[i] = { name: n, imm: '' }; });
FC[8] = { name: 'memory.init', imm: 'md' }; FC[9] = { name: 'data.drop', imm: 'd' };
FC[10] = { name: 'memory.copy', imm: 'mm' }; FC[11] = { name: 'memory.fill', imm: 'mi' };
FC[12] = { name: 'table.init', imm: 'et' }; FC[13] = { name: 'elem.drop', imm: 'e' };
FC[14] = { name: 'table.copy', imm: 'tt2' }; FC[15] = { name: 'table.grow', imm: 'tb' };
FC[16] = { name: 'table.size', imm: 'tb' }; FC[17] = { name: 'table.fill', imm: 'tb' };

// 0xFD prefix: SIMD and relaxed SIMD
const FD = Object.create(null);
function simd(code, name, imm = '', align) { FD[code] = { name, imm, align }; }
[['v128.load', 4], ['v128.load8x8_s', 3], ['v128.load8x8_u', 3], ['v128.load16x4_s', 3], ['v128.load16x4_u', 3],
  ['v128.load32x2_s', 3], ['v128.load32x2_u', 3], ['v128.load8_splat', 0], ['v128.load16_splat', 1],
  ['v128.load32_splat', 2], ['v128.load64_splat', 3], ['v128.store', 4]].forEach(([n, a], i) => simd(i, n, 'm', a));
simd(0x0c, 'v128.const', 'v128'); simd(0x0d, 'i8x16.shuffle', 'shuf'); simd(0x0e, 'i8x16.swizzle');
'i8x16.splat i16x8.splat i32x4.splat i64x2.splat f32x4.splat f64x2.splat'.split(' ').forEach((n, i) => simd(0x0f + i, n));
'i8x16.extract_lane_s i8x16.extract_lane_u i8x16.replace_lane i16x8.extract_lane_s i16x8.extract_lane_u i16x8.replace_lane i32x4.extract_lane i32x4.replace_lane i64x2.extract_lane i64x2.replace_lane f32x4.extract_lane f32x4.replace_lane f64x2.extract_lane f64x2.replace_lane'
  .split(' ').forEach((n, i) => simd(0x15 + i, n, 'lane'));
const simdPlain = (start, names) => names.split(' ').forEach((n, i) => { if (n !== '-') simd(start + i, n); });
simdPlain(0x23, 'i8x16.eq i8x16.ne i8x16.lt_s i8x16.lt_u i8x16.gt_s i8x16.gt_u i8x16.le_s i8x16.le_u i8x16.ge_s i8x16.ge_u');
simdPlain(0x2d, 'i16x8.eq i16x8.ne i16x8.lt_s i16x8.lt_u i16x8.gt_s i16x8.gt_u i16x8.le_s i16x8.le_u i16x8.ge_s i16x8.ge_u');
simdPlain(0x37, 'i32x4.eq i32x4.ne i32x4.lt_s i32x4.lt_u i32x4.gt_s i32x4.gt_u i32x4.le_s i32x4.le_u i32x4.ge_s i32x4.ge_u');
simdPlain(0x41, 'f32x4.eq f32x4.ne f32x4.lt f32x4.gt f32x4.le f32x4.ge');
simdPlain(0x47, 'f64x2.eq f64x2.ne f64x2.lt f64x2.gt f64x2.le f64x2.ge');
simdPlain(0x4d, 'v128.not v128.and v128.andnot v128.or v128.xor v128.bitselect v128.any_true');
[['v128.load8_lane', 0], ['v128.load16_lane', 1], ['v128.load32_lane', 2], ['v128.load64_lane', 3],
  ['v128.store8_lane', 0], ['v128.store16_lane', 1], ['v128.store32_lane', 2], ['v128.store64_lane', 3]]
  .forEach(([n, a], i) => simd(0x54 + i, n, 'ml', a));
simd(0x5c, 'v128.load32_zero', 'm', 2); simd(0x5d, 'v128.load64_zero', 'm', 3);
simdPlain(0x5e, 'f32x4.demote_f64x2_zero f64x2.promote_low_f32x4');
simdPlain(0x60, 'i8x16.abs i8x16.neg i8x16.popcnt i8x16.all_true i8x16.bitmask i8x16.narrow_i16x8_s i8x16.narrow_i16x8_u f32x4.ceil f32x4.floor f32x4.trunc f32x4.nearest i8x16.shl i8x16.shr_s i8x16.shr_u i8x16.add i8x16.add_sat_s i8x16.add_sat_u i8x16.sub i8x16.sub_sat_s i8x16.sub_sat_u f64x2.ceil f64x2.floor i8x16.min_s i8x16.min_u i8x16.max_s i8x16.max_u f64x2.trunc i8x16.avgr_u i16x8.extadd_pairwise_i8x16_s i16x8.extadd_pairwise_i8x16_u i32x4.extadd_pairwise_i16x8_s i32x4.extadd_pairwise_i16x8_u');
simdPlain(0x80, 'i16x8.abs i16x8.neg i16x8.q15mulr_sat_s i16x8.all_true i16x8.bitmask i16x8.narrow_i32x4_s i16x8.narrow_i32x4_u i16x8.extend_low_i8x16_s i16x8.extend_high_i8x16_s i16x8.extend_low_i8x16_u i16x8.extend_high_i8x16_u i16x8.shl i16x8.shr_s i16x8.shr_u i16x8.add i16x8.add_sat_s i16x8.add_sat_u i16x8.sub i16x8.sub_sat_s i16x8.sub_sat_u f64x2.nearest i16x8.mul i16x8.min_s i16x8.min_u i16x8.max_s i16x8.max_u - i16x8.avgr_u i16x8.extmul_low_i8x16_s i16x8.extmul_high_i8x16_s i16x8.extmul_low_i8x16_u i16x8.extmul_high_i8x16_u');
simdPlain(0xa0, 'i32x4.abs i32x4.neg - i32x4.all_true i32x4.bitmask - - i32x4.extend_low_i16x8_s i32x4.extend_high_i16x8_s i32x4.extend_low_i16x8_u i32x4.extend_high_i16x8_u i32x4.shl i32x4.shr_s i32x4.shr_u i32x4.add - - i32x4.sub - - - i32x4.mul i32x4.min_s i32x4.min_u i32x4.max_s i32x4.max_u i32x4.dot_i16x8_s - i32x4.extmul_low_i16x8_s i32x4.extmul_high_i16x8_s i32x4.extmul_low_i16x8_u i32x4.extmul_high_i16x8_u');
simdPlain(0xc0, 'i64x2.abs i64x2.neg - i64x2.all_true i64x2.bitmask - - i64x2.extend_low_i32x4_s i64x2.extend_high_i32x4_s i64x2.extend_low_i32x4_u i64x2.extend_high_i32x4_u i64x2.shl i64x2.shr_s i64x2.shr_u i64x2.add - - i64x2.sub - - - i64x2.mul i64x2.eq i64x2.ne i64x2.lt_s i64x2.gt_s i64x2.le_s i64x2.ge_s i64x2.extmul_low_i32x4_s i64x2.extmul_high_i32x4_s i64x2.extmul_low_i32x4_u i64x2.extmul_high_i32x4_u');
simdPlain(0xe0, 'f32x4.abs f32x4.neg - f32x4.sqrt f32x4.add f32x4.sub f32x4.mul f32x4.div f32x4.min f32x4.max f32x4.pmin f32x4.pmax f64x2.abs f64x2.neg - f64x2.sqrt f64x2.add f64x2.sub f64x2.mul f64x2.div f64x2.min f64x2.max f64x2.pmin f64x2.pmax i32x4.trunc_sat_f32x4_s i32x4.trunc_sat_f32x4_u f32x4.convert_i32x4_s f32x4.convert_i32x4_u i32x4.trunc_sat_f64x2_s_zero i32x4.trunc_sat_f64x2_u_zero f64x2.convert_low_i32x4_s f64x2.convert_low_i32x4_u');
simdPlain(0x100, 'i8x16.relaxed_swizzle i32x4.relaxed_trunc_f32x4_s i32x4.relaxed_trunc_f32x4_u i32x4.relaxed_trunc_f64x2_s_zero i32x4.relaxed_trunc_f64x2_u_zero f32x4.relaxed_madd f32x4.relaxed_nmadd f64x2.relaxed_madd f64x2.relaxed_nmadd i8x16.relaxed_laneselect i16x8.relaxed_laneselect i32x4.relaxed_laneselect i64x2.relaxed_laneselect f32x4.relaxed_min f32x4.relaxed_max f64x2.relaxed_min f64x2.relaxed_max i16x8.relaxed_q15mulr_s i16x8.relaxed_dot_i8x16_i7x16_s i32x4.relaxed_dot_i8x16_i7x16_add_s');

// 0xFE prefix: threads (atomics)
const FE = Object.create(null);
function atom(code, name, imm, align) { FE[code] = { name, imm, align }; }
atom(0x00, 'memory.atomic.notify', 'm', 2); atom(0x01, 'memory.atomic.wait32', 'm', 2); atom(0x02, 'memory.atomic.wait64', 'm', 3);
atom(0x03, 'atomic.fence', 'fence');
[['i32.atomic.load', 2], ['i64.atomic.load', 3], ['i32.atomic.load8_u', 0], ['i32.atomic.load16_u', 1], ['i64.atomic.load8_u', 0],
  ['i64.atomic.load16_u', 1], ['i64.atomic.load32_u', 2], ['i32.atomic.store', 2], ['i64.atomic.store', 3], ['i32.atomic.store8', 0],
  ['i32.atomic.store16', 1], ['i64.atomic.store8', 0], ['i64.atomic.store16', 1], ['i64.atomic.store32', 2]]
  .forEach(([n, a], i) => atom(0x10 + i, n, 'm', a));
['add', 'sub', 'and', 'or', 'xor', 'xchg', 'cmpxchg'].forEach((op, g) => {
  const suf = op === 'cmpxchg' ? 'cmpxchg' : op;
  [['i32.atomic.rmw.', 2], ['i64.atomic.rmw.', 3], ['i32.atomic.rmw8.', 0, '_u'], ['i32.atomic.rmw16.', 1, '_u'],
    ['i64.atomic.rmw8.', 0, '_u'], ['i64.atomic.rmw16.', 1, '_u'], ['i64.atomic.rmw32.', 2, '_u']]
    .forEach(([pre, a, u], i) => atom(0x1e + g * 7 + i, pre + suf + (u || ''), 'm', a));
});

// 0xFB prefix: GC
const FB = Object.create(null);
[['struct.new', 't'], ['struct.new_default', 't'], ['struct.get', 'tf'], ['struct.get_s', 'tf'], ['struct.get_u', 'tf'],
  ['struct.set', 'tf'], ['array.new', 't'], ['array.new_default', 't'], ['array.new_fixed', 'tn'], ['array.new_data', 'td'],
  ['array.new_elem', 'te'], ['array.get', 't'], ['array.get_s', 't'], ['array.get_u', 't'], ['array.set', 't'], ['array.len', ''],
  ['array.fill', 't'], ['array.copy', 't2'], ['array.init_data', 'td'], ['array.init_elem', 'te'], ['ref.test', 'rt'],
  ['ref.test', 'rtn'], ['ref.cast', 'rt'], ['ref.cast', 'rtn'], ['br_on_cast', 'boc'], ['br_on_cast_fail', 'boc'],
  ['any.convert_extern', ''], ['extern.convert_any', ''], ['ref.i31', ''], ['i31.get_s', ''], ['i31.get_u', '']]
  .forEach(([n, imm], i) => { FB[i] = { name: n, imm }; });

const PREFIX = { 0xfb: FB, 0xfc: FC, 0xfd: FD, 0xfe: FE };

// Value types and abbreviated heap types (single-byte negative s33 values).
const VALTYPE = { 0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64', 0x7b: 'v128' };
const HEAPTYPE = {
  0x70: 'func', 0x6f: 'extern', 0x6e: 'any', 0x6d: 'eq', 0x6c: 'i31', 0x6b: 'struct', 0x6a: 'array', 0x69: 'exn',
  0x71: 'none', 0x72: 'noextern', 0x73: 'nofunc', 0x74: 'noexn',
};
const REF_SHORT = {
  func: 'funcref', extern: 'externref', any: 'anyref', eq: 'eqref', i31: 'i31ref', struct: 'structref', array: 'arrayref',
  exn: 'exnref', none: 'nullref', noextern: 'nullexternref', nofunc: 'nullfuncref', noexn: 'nullexnref',
};

const SECTION = {
  0: 'custom', 1: 'type', 2: 'import', 3: 'function', 4: 'table', 5: 'memory', 6: 'global', 7: 'export', 8: 'start',
  9: 'element', 10: 'code', 11: 'data', 12: 'datacount', 13: 'tag',
};
const EXTERN_KIND = ['func', 'table', 'memory', 'global', 'tag'];

module.exports = { ONE, PREFIX, FB, FC, FD, FE, VALTYPE, HEAPTYPE, REF_SHORT, SECTION, EXTERN_KIND };
