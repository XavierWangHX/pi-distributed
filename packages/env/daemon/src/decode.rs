//! WHATWG UTF-8 decoding that matches Node's `new TextDecoder().decode(bytes)` of a whole input when the input arrives
//! in pieces (Durable `env/decode.ts`): invalid sequences become U+FFFD by the maximal-subpart rule, and only a
//! byte-order mark at the very start is dropped.
//!
//! On Windows the exec output stream (`StreamDecoder`) departs from that contract for bytes that are not valid
//! UTF-8: legacy console programs there write in the system's ANSI code page (`systeminfo` on a Chinese Windows
//! writes GBK), and those bytes would otherwise reach the client as replacement characters. Such runs are decoded
//! with `MultiByteToWideChar(CP_ACP)`; valid UTF-8 runs pass through untouched, so UTF-8 output is unaffected.

use encoding_rs::{Decoder, UTF_8};

/// Decodes one stream chunk by chunk, dropping a leading byte-order mark.
pub struct StreamDecoder {
    #[cfg(not(windows))]
    decoder: Decoder,
    #[cfg(windows)]
    pending: Vec<u8>,
    #[cfg(windows)]
    bom_checked: bool,
}

impl StreamDecoder {
    pub fn new() -> StreamDecoder {
        #[cfg(not(windows))]
        {
            // Removes a UTF-8 BOM only; plain `new_decoder()` would also sniff UTF-16 BOMs and switch encodings.
            return StreamDecoder { decoder: UTF_8.new_decoder_with_bom_removal() };
        }
        #[cfg(windows)]
        {
            return StreamDecoder { pending: Vec::new(), bom_checked: false };
        }
    }

    /// Text for `bytes`, holding back an incomplete character; with `last`, the end of the stream.
    #[cfg(not(windows))]
    pub fn decode(&mut self, bytes: &[u8], last: bool) -> String {
        decode_into(&mut self.decoder, bytes, last)
    }

    /// Text for `bytes`, with runs of invalid UTF-8 decoded in the system's ANSI code page; see the module docs.
    #[cfg(windows)]
    pub fn decode(&mut self, bytes: &[u8], last: bool) -> String {
        let mut buffered = std::mem::take(&mut self.pending);
        let mut data: &[u8] = bytes;
        if !buffered.is_empty() {
            buffered.extend_from_slice(bytes);
            data = &buffered;
        }
        if !self.bom_checked {
            // The mark needs three bytes to tell; hold a shorter stream start until more arrives or the stream ends.
            if !last && data.len() < 3 {
                self.pending = data.to_vec();
                return String::new();
            }
            if data.starts_with(&[0xef, 0xbb, 0xbf]) {
                data = &data[3..];
            }
            self.bom_checked = true;
        }
        let mut out = String::new();
        let mut rest = data;
        while !rest.is_empty() {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    out.push_str(text);
                    rest = &[];
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    out.push_str(std::str::from_utf8(&rest[..valid]).expect("valid_up_to prefix is valid utf-8"));
                    let invalid_end = match error.error_len() {
                        Some(len) => valid + len,
                        // An incomplete tail: hold it for the next chunk, unless the stream ends here.
                        None if !last => {
                            self.pending = rest[valid..].to_vec();
                            return out;
                        }
                        None => rest.len(),
                    };
                    out.push_str(&decode_acp(&rest[valid..invalid_end]));
                    rest = &rest[invalid_end..];
                }
            }
        }
        out
    }
}

/// Decodes code-page bytes with the system's ANSI code page (GBK on a Chinese Windows).
#[cfg(windows)]
fn decode_acp(bytes: &[u8]) -> String {
    use std::ptr;
    use windows_sys::Win32::Globalization::{MultiByteToWideChar, CP_ACP};
    if bytes.is_empty() {
        return String::new();
    }
    unsafe {
        let length = MultiByteToWideChar(CP_ACP, 0, bytes.as_ptr(), bytes.len() as i32, ptr::null_mut(), 0);
        if length <= 0 {
            return String::new();
        }
        let mut wide = vec![0u16; length as usize];
        MultiByteToWideChar(CP_ACP, 0, bytes.as_ptr(), bytes.len() as i32, wide.as_mut_ptr(), length);
        String::from_utf16_lossy(&wide)
    }
}

/// A decoder for a byte range that does not start at the beginning of its input: no BOM handling at all.
pub fn range_decoder() -> Decoder {
    UTF_8.new_decoder_without_bom_handling()
}

pub fn decode_into(decoder: &mut Decoder, bytes: &[u8], last: bool) -> String {
    let capacity = decoder
        .max_utf8_buffer_length(bytes.len())
        .unwrap_or(bytes.len() * 3 + 16);
    let mut text = String::with_capacity(capacity);
    let (_result, read, _replaced) = decoder.decode_to_string(bytes, &mut text, last);
    debug_assert_eq!(read, bytes.len());
    text
}

/// Whether decoding the whole input drops its first three bytes as a byte-order mark.
pub fn starts_with_bom(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xef, 0xbb, 0xbf])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(windows))]
    #[test]
    fn keeps_a_feff_that_does_not_start_the_stream() {
        let mut decoder = StreamDecoder::new();
        let bytes = [0xe2, 0x82, 0xef, 0xbb, 0xbf, 0x61];
        let text: String = bytes
            .iter()
            .map(|byte| decoder.decode(&[*byte], false))
            .collect::<String>()
            + &decoder.decode(&[], true);
        assert_eq!(text, "\u{fffd}\u{feff}a");
    }

    #[cfg(not(windows))]
    #[test]
    fn drops_only_a_leading_mark_and_never_sniffs_utf16() {
        let mut decoder = StreamDecoder::new();
        assert_eq!(
            decoder.decode(&[0xef, 0xbb], false) + &decoder.decode(&[0xbf, 0x61], true),
            "a"
        );
        let mut decoder = StreamDecoder::new();
        assert_eq!(
            decoder.decode(&[0xff, 0xfe, 0x41, 0x00], true),
            "\u{fffd}\u{fffd}A\u{0}"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn replaces_an_incomplete_sequence_once() {
        let mut decoder = StreamDecoder::new();
        assert_eq!(decoder.decode(&[0xe2, 0x82, 0x41], true), "\u{fffd}A");
        let mut decoder = StreamDecoder::new();
        assert_eq!(decoder.decode(&[0xe2, 0x82], true), "\u{fffd}");
    }

    #[cfg(windows)]
    #[test]
    fn drops_a_leading_mark_held_across_chunks() {
        let mut decoder = StreamDecoder::new();
        assert_eq!(decoder.decode(&[0xef, 0xbb], false) + &decoder.decode(&[0xbf, 0x61], true), "a");
    }

    #[cfg(windows)]
    #[test]
    fn decodes_code_page_bytes_instead_of_replacing_them() {
        let bytes = [0xc4, 0xe3, 0xba, 0xc3]; // "你好" in GBK, invalid as UTF-8
        let text = StreamDecoder::new().decode(&bytes, true);
        assert_eq!(text, decode_acp(&bytes));
        assert!(!text.contains('\u{fffd}'));
    }

    #[cfg(windows)]
    #[test]
    fn keeps_valid_utf8_runs_untouched_between_code_page_runs() {
        let mut decoder = StreamDecoder::new();
        let text = decoder.decode(&[0x61, 0xc4, 0xe3, 0x62], true);
        assert_eq!(text, format!("a{}b", decode_acp(&[0xc4, 0xe3])));
    }
}
