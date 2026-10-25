#!/usr/bin/env python3
"""RPK signature verifier mirroring @aiot-toolkit SignUtil.js (RPK Sig Block 42)."""
import struct, hashlib, subprocess, sys, os, tempfile, binascii

def crc32_name(name: str) -> int:
    return binascii.crc32(name.encode('utf-8')) & 0xffffffff

def sha256(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()

def section_digest(chunk: bytes) -> bytes:
    return sha256(b'\xa5' + struct.pack('<i', len(chunk)) + chunk)

def rsa_verify(data: bytes, sig: bytes, cert_der: bytes) -> bool:
    with tempfile.TemporaryDirectory() as d:
        cert = os.path.join(d, 'cert.pem')
        pub = os.path.join(d, 'pub.pem')
        data_p = os.path.join(d, 'data.bin')
        sig_p = os.path.join(d, 'sig.bin')
        open(cert, 'wb').write(b'-----BEGIN CERTIFICATE-----\n' +
            __import__('base64').b64encode(cert_der) + b'\n-----END CERTIFICATE-----\n')
        r0 = subprocess.run(['openssl', 'x509', '-in', cert, '-pubkey', '-noout'],
                            capture_output=True)
        if r0.returncode != 0:
            return False
        open(pub, 'wb').write(r0.stdout)
        open(data_p, 'wb').write(data)
        open(sig_p, 'wb').write(sig)
        r = subprocess.run(['openssl', 'dgst', '-sha256', '-verify', pub,
                            '-signature', sig_p, data_p],
                           capture_output=True)
        return r.returncode == 0

def verify(rpk_path, expected_cert=None):
    data = open(rpk_path, 'rb').read()
    ok = True

    # EOCD
    eocd = data.rfind(b'PK\x05\x06')
    cd_start = struct.unpack('<i', data[eocd + 16:eocd + 20])[0]

    # signchunk: ends at cd_start with magic; trailing size field == leading size
    magic = b'RPK Sig Block 42'
    assert data[cd_start - 16:cd_start] == magic, 'sig magic missing at CD boundary'
    tail_size = struct.unpack('<i', data[cd_start - 24:cd_start - 20])[0]
    L = tail_size + 8
    assert data[cd_start - L:cd_start - L + 8] == struct.pack('<ii', tail_size, 0), \
        'signchunk size fields inconsistent'
    sc = data[cd_start - L:cd_start]
    header = data[:cd_start - L]
    central = data[cd_start:eocd]
    # saveChunk patched the EOCD CD-offset after signing; restore for digest
    footer = bytearray(data[eocd:])
    footer[16:20] = struct.pack('<i', cd_start - L)
    footer = bytes(footer)

    dh, dc, df = section_digest(header), section_digest(central), section_digest(footer)
    whole = b'\x5a' + struct.pack('<i', 3) + dh + dc + df
    sign = sha256(whole)
    print(f'sections: header={len(header)} central={len(central)} footer={len(footer)}')
    print(f'wholeData digest: {sign.hex()}')

    # parse signchunk
    import zipfile, io
    zf = zipfile.ZipFile(io.BytesIO(data))
    all_names = {i.filename for i in zf.infolist() if not i.is_dir()}
    nfiles = len(all_names)

    p = 0
    def i32():
        nonlocal p
        v = struct.unpack('<i', sc[p:p + 4])[0]; p += 4; return v

    size0 = i32(); i32()
    assert size0 == L - 8, f'size field {size0} != {L-8}'
    signdata = sig = cert_der = pubkey = None
    filelist_sig = filelist_signed = None
    file_entries = []
    while p < L - 24:
        kv_size = i32(); i32(); kv_id = i32()
        val_size = i32()
        if kv_id == 0x01000101:
            block_size = i32()
            sd_size = i32()
            signdata = sc[p:p + sd_size]; p += sd_size
            sigs_size = i32()
            end = p + sigs_size
            while p < end:
                s_size = i32(); s_id = i32(); s_len = i32()
                sig = sc[p:p + s_len]; p += s_len
            pk_size = i32()
            pubkey = sc[p:p + pk_size]; p += pk_size
        elif kv_id == 0x01000201:
            # saveDigestChunk: [digests.len(4)][digests 4+38*n][sign.size(4)][id(4)][siglen(4)][sig]
            dig_len = i32()
            assert dig_len == 4 + 38 * nfiles, f'dig_len {dig_len} != {4 + 38 * nfiles}'
            filelist_signed = sc[p:p + dig_len]; p += dig_len
            sz = i32(); sid = i32(); sl = i32()
            filelist_sig = sc[p:p + sl]; p += sl
            assert sz == sl + 8 and sid == 0x0103, 'filelist sign block shape'
            e = 4
            while e < len(filelist_signed):
                nh = struct.unpack('<I', filelist_signed[e:e + 4])[0]
                hl = struct.unpack('<H', filelist_signed[e + 4:e + 6])[0]
                h = filelist_signed[e + 6:e + 6 + hl]
                file_entries.append((nh, h))
                e += 6 + hl
        else:
            raise AssertionError(f'unknown kv id {kv_id:#x}')

    # digestBlock inside signdata must equal `sign`
    # signdata: [digests.size][digestBlock: [len][0x0103][32][sign]][certs.size][certBlock][0]
    assert signdata[8:12] == struct.pack('<i', 0x0103), 'digest block shape'
    assert signdata[12:16] == struct.pack('<i', 32), 'digest block shape'
    embedded = signdata[16:48]
    print('digest block matches section digests:', 'OK' if embedded == sign else 'FAIL')
    ok = ok and embedded == sign

    # certBlock follows digestBlock (4+44) + certs.size(4)
    cert_len = struct.unpack('<i', signdata[52:56])[0]
    cert_der = signdata[56:56 + cert_len]
    print('embedded cert length:', cert_len)

    # outer signature over signdata
    r1 = rsa_verify(signdata, sig, cert_der)
    print('signdata RSA-SHA256 verify:', 'OK' if r1 else 'FAIL')
    ok = ok and r1

    # filelist signature over [0x0103][entries]
    r2 = rsa_verify(filelist_signed, filelist_sig, cert_der)
    print('filelist RSA-SHA256 verify:', 'OK' if r2 else 'FAIL')
    ok = ok and r2

    # per-file digests vs actual zip contents (zip parse via central dir)
    import zipfile, io
    z = zipfile.ZipFile(io.BytesIO(data))
    names = {i.filename for i in z.infolist() if not i.is_dir()}
    listed = set()
    for nh, h in file_entries:
        # find name by crc match
        match = [n for n in names if crc32_name(n) == nh]
        assert len(match) == 1, f'crc collision/missing for {nh:#x}'
        n = match[0]
        listed.add(n)
        actual = sha256(z.read(n))
        st = 'OK' if actual == h else 'MISMATCH'
        if actual != h: ok = False
        print(f'  file {st}: {n}')
    missing = names - listed
    if missing:
        print('  files NOT covered by signature:', missing)
        ok = False

    # cert check
    fp = hashlib.sha256(cert_der).hexdigest()
    print('embedded cert sha256:', fp)
    if expected_cert:
        import base64
        with open(expected_cert, 'rb') as f:
            pem = f.read()
        der = base64.b64decode(b''.join(l for l in pem.splitlines() if b'-----' not in l))
        same = der == cert_der
        print(f'matches {expected_cert}:', 'OK' if same else 'FAIL')
        ok = ok and same
    else:
        print('cert comparison skipped (pass a certificate.pem path to compare)')

    print('\nRESULT:', 'ALL SIGNATURE CHECKS PASSED' if ok else 'VERIFICATION FAILED')
    return 0 if ok else 1

if __name__ == '__main__':
    sys.exit(verify(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None))
