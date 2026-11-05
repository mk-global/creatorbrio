# usage: python3 -I framecmp.py A.rgb B.rgb x0 x1 y0 y1 -> PSNR dB and max channel diff over a region (1080-wide rgb24)
import sys, math
a = open(sys.argv[1], 'rb').read(); b = open(sys.argv[2], 'rb').read(); x0, x1, y0, y1 = map(int, sys.argv[3:7]); W = 1080
se = n = mx = 0
for y in range(y0, y1, 2):
    for x in range(x0, x1, 2):
        i = (y * W + x) * 3
        for c in range(3):
            d = a[i + c] - b[i + c]; se += d * d; n += 1; mx = max(mx, abs(d))
print('%.1f dB, max %d' % (10 * math.log10(65025 / max(se / n, 1e-9)), mx))
