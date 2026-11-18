// Draws the Livemark app icon into an .iconset directory:  swift make-icon.swift <out.iconset>
// Original artwork: a white plate with a dark serif "L" and a quiet paragraph tucked into the L's open corner.
import AppKit
import CoreText

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: make-icon <out.iconset>\n".utf8))
    exit(2)
}
let outDir = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

// Serif faces that ship with macOS, best first.
let fontCandidates = ["Palatino-Bold", "Georgia-Bold", "Charter-Bold", "TimesNewRomanPS-BoldMT"]

func letterOutline() -> CGPath {
    for name in fontCandidates {
        let font = CTFontCreateWithName(name as CFString, 1000, nil)
        guard CTFontCopyPostScriptName(font) as String == name else { continue }
        var character: [UniChar] = [0x4C]
        var glyph: [CGGlyph] = [0]
        if CTFontGetGlyphsForCharacters(font, &character, &glyph, 1), let path = CTFontCreatePathForGlyph(font, glyph[0], nil) {
            return path
        }
    }
    FileHandle.standardError.write(Data("no serif font found for the icon\n".utf8))
    exit(1)
}

// The letter, scaled to its cap height and placed on the 1024-unit canvas, plus where its strokes end.
struct Letter {
    let path: CGPath
    let topSerifRight: CGFloat
    let footTop: CGFloat
}

func placedLetter(capHeight: CGFloat, left: CGFloat) -> Letter {
    let raw = letterOutline()
    let box = raw.boundingBoxOfPath
    let scale = capHeight / box.height
    var transform = CGAffineTransform(translationX: left, y: 512 - capHeight / 2).scaledBy(x: scale, y: scale).translatedBy(x: -box.minX, y: -box.minY)
    let path = raw.copy(using: &transform) ?? raw
    let placed = path.boundingBoxOfPath

    var topSerifRight = placed.minX
    var x = placed.maxX
    while x > placed.minX {
        if path.contains(CGPoint(x: x, y: placed.maxY - 8)) { topSerifRight = x; break }
        x -= 1
    }
    var footTop = placed.minY
    var y = placed.maxY
    while y > placed.minY {
        if path.contains(CGPoint(x: placed.maxX - 6, y: y)) { footTop = y; break }
        y -= 1
    }
    return Letter(path: path, topSerifRight: topSerifRight, footTop: footTop)
}

func render(pixels: Int) -> Data? {
    let space = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
                              space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.scaleBy(x: CGFloat(pixels) / 1024, y: CGFloat(pixels) / 1024)

    // Apple's icon grid: an 824-unit plate inside a 100-unit margin.
    let plate = CGPath(roundedRect: CGRect(x: 100, y: 100, width: 824, height: 824), cornerWidth: 186, cornerHeight: 186, transform: nil)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -8), blur: 22, color: CGColor(gray: 0, alpha: 0.22))
    ctx.addPath(plate)
    ctx.setFillColor(CGColor(gray: 1, alpha: 1))
    ctx.fillPath()
    ctx.restoreGState()

    ctx.saveGState()
    ctx.addPath(plate)
    ctx.clip()
    let colors = [CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1), CGColor(srgbRed: 0.955, green: 0.955, blue: 0.95, alpha: 1)] as CFArray
    if let gradient = CGGradient(colorsSpace: space, colors: colors, locations: [0, 1]) {
        ctx.drawLinearGradient(gradient, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])
    }
    ctx.restoreGState()

    let capHeight: CGFloat = 500
    let letter = placedLetter(capHeight: capHeight, left: 252)

    // The paragraph sits only in the space the L leaves open, and is dropped at sizes where it would turn to mush.
    if pixels >= 64 {
        let (barHeight, pitch, gap, right): (CGFloat, CGFloat, CGFloat, CGFloat) = (30, 70, 40, 772)
        let left = letter.topSerifRight + gap
        let top = 512 + capHeight / 2
        ctx.setFillColor(CGColor(srgbRed: 0.905, green: 0.905, blue: 0.9, alpha: 1))
        var y = top - barHeight
        while y >= letter.footTop + gap {
            let isLast = y - pitch < letter.footTop + gap
            let width = (right - left) * (isLast ? 0.62 : 1)
            ctx.addPath(CGPath(roundedRect: CGRect(x: left, y: y, width: width, height: barHeight),
                               cornerWidth: barHeight / 2, cornerHeight: barHeight / 2, transform: nil))
            ctx.fillPath()
            y -= pitch
        }
    }

    ctx.addPath(letter.path)
    ctx.setFillColor(CGColor(srgbRed: 0.2, green: 0.2, blue: 0.21, alpha: 1))
    ctx.fillPath()

    guard let image = ctx.makeImage() else { return nil }
    return NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
}

for (points, scale) in [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)] {
    let name = scale == 1 ? "icon_\(points)x\(points).png" : "icon_\(points)x\(points)@2x.png"
    guard let png = render(pixels: points * scale) else {
        FileHandle.standardError.write(Data("could not render \(name)\n".utf8))
        exit(1)
    }
    try png.write(to: outDir.appendingPathComponent(name))
}
