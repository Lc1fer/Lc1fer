var fingerprint = {
    Nexitally: "9a 91 7b 28 ae dd 1b 11 c2 e2 d2 14 fd e5 35 e5 ca d7 4b e1 fb 09 dc 02 0b 92 e2 67 c5 0e 8f 73",
    YToo: ""
};
function operator(e, a) {
    var c = $arguments.airport,
    r = $arguments.custom;
    return fingerprint[c] || r ? e.map((function (e) {
            return e = addFingerprint(e, fingerprint[c] || r, a)
        })) : e
}
function addFingerprint(e, a, c) {
    if ("trojan" === e.type && a && "undefined" !== a)
        switch (c) {
        case "Surge":
            e.tfo = "".concat(e.tfo || !1, ", server-cert-fingerprint-sha256=").concat(a);
            break;
        case "QX":
            e.tfo = "".concat(e.tfo || !1, ", tls-cert-sha256=").concat(a)
        }
    return e
}
