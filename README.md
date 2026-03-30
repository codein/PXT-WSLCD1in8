# LCD1in8


Here’s why `LCD_Display` is slow and how you can optimize it.

---

## Ways to speed it up

### Partial / dirty-region updates

If possible, only refresh regions that changed instead of the whole 160×128. That directly reduces the number of SPI transfers per frame.

### 4. Preallocate buffers outside the loop

Create `cmdBuf`, `rspBuf`, and `lcdBuf` once (e.g. in `onStart()` or during init), and reuse them each frame. Avoid allocating new buffers in the hot path.



## Implementation plan for **partial / dirty-region updates**:

---

## 1. Architecture summary

| Component | Role |
|-----------|------|
| **SRAM** | 160×128 frame buffer (2 bytes/pixel = 40,960 bytes) |
| **LCD_SetPoint** | Single write path to SRAM (used by all drawing) |
| **Address formula** | `Addr = (X + Y * 160) * 2` |
| **LCD_SetWindows** | Sets ST7735 update window (supports arbitrary rects) |

All drawing flows through `LCD_SetPoint`, so dirty tracking can be centralized there.

---

## 2. Implementation pieces

### Step 1: Dirty-rect state

Add module-level state:

```typescript
// After the existing let declarations (around line 31)
let dirtyMinX = 999;
let dirtyMinY = 999;
let dirtyMaxX = -1;
let dirtyMaxY = -1;
let isDirty = false;
```

### Step 2: Marking regions dirty in `LCD_SetPoint`

`LCD_SetPoint` (around 1592) becomes:

```typescript
function LCD_SetPoint(Xpoint: number, Ypoint: number, Color: number): void {
    // Clamp to valid range (ST7735 uses 1-based coords in some places)
    if (Xpoint < 0 || Xpoint >= 160 || Ypoint < 0 || Ypoint >= 128) return;

    let Addr = (Xpoint + Ypoint * 160) * 2;
    SPIRAM_WR_Byte(Addr, Color >> 8);
    SPIRAM_WR_Byte(Addr + 1, Color & 0xff);

    // Mark dirty region
    isDirty = true;
    if (Xpoint < dirtyMinX) dirtyMinX = Xpoint;
    if (Ypoint < dirtyMinY) dirtyMinY = Ypoint;
    if (Xpoint > dirtyMaxX) dirtyMaxX = Xpoint;
    if (Ypoint > dirtyMaxY) dirtyMaxY = Ypoint;
}
```

### Step 3: Resetting dirty state

- **Full-screen clear** (`LCD_ClearBuf`, `LCD_Clear`, `LCD_Filling`) → mark whole screen dirty.
- After a partial update → clear dirty state.

Reset helper:

```typescript
function Dirty_Reset(): void {
    dirtyMinX = 999;
    dirtyMinY = 999;
    dirtyMaxX = -1;
    dirtyMaxY = -1;
    isDirty = false;
}

function Dirty_MarkFull(): void {
    dirtyMinX = 0;
    dirtyMinY = 0;
    dirtyMaxX = 159;
    dirtyMaxY = 127;
    isDirty = true;
}
```

In `LCD_ClearBuf`, `LCD_Clear`, `LCD_Filling`: call `Dirty_MarkFull()`.

### Step 4: Core region transfer

Add a function to transfer a single region from SRAM to LCD:

```typescript
function LCD_DisplayRegion(x1: number, y1: number, x2: number, y2: number): void {
    let w = x2 - x1 + 1;
    let h = y2 - y1 + 1;
    let rowBytes = w * 2;  // bytes per row

    LCD_SetWindows(x1, y1, x2, y2);

    let rbuf: number[] = [];
    for (let i = 0; i < rowBytes; i++) rbuf[i] = 0;

    for (let row = y1; row <= y2; row++) {
        let sramAddr = (row * 160 + x1) * 2;

        // Read row from SRAM
        pins.digitalWritePin(DigitalPin.P2, 0);
        pins.spiWrite(SRAM_CMD_READ);
        pins.spiWrite(sramAddr >> 16);
        pins.spiWrite((sramAddr >> 8) & 0xff);
        pins.spiWrite(sramAddr & 0xff);
        for (let offset = 0; offset < rowBytes; offset++) {
            rbuf[offset] = pins.spiWrite(0x00);
        }
        pins.digitalWritePin(DigitalPin.P2, 1);

        // Write row to LCD
        pins.digitalWritePin(DigitalPin.P12, 1);
        pins.digitalWritePin(DigitalPin.P16, 0);
        for (let offset = 0; offset < rowBytes; offset++) {
            pins.spiWrite(rbuf[offset]);
        }
        pins.digitalWritePin(DigitalPin.P16, 1);
    }

    LCD_WriteReg(0x29);  // Display on
}
```

**Note:** `SRAM_CMD_READ` is 3-byte (24-bit) address; `sramAddr >> 16` is 0 for this size. Current code uses only 2 address bytes, so keep:

```typescript
pins.spiWrite(SRAM_CMD_READ);
pins.spiWrite(0);
pins.spiWrite((sramAddr >> 8) & 0xff);
pins.spiWrite(sramAddr & 0xff);
```

### Step 5: New `LCD_DisplayDirty()` block

```typescript
//% blockId=LCD_DisplayDirty
//% block="Show Changes Only"
//% weight=189
export function LCD_DisplayDirty(): void {
    if (!isDirty) return;

    SPIRAM_Set_Mode(SRAM_STREAM_MODE);
    LCD_DisplayRegion(dirtyMinX, dirtyMinY, dirtyMaxX, dirtyMaxY);
    Dirty_Reset();
}
```

### Step 6: Keep full-screen API

`LCD_Display()` can stay as:

```typescript
export function LCD_Display(): void {
    // ... existing full-screen implementation ...
    Dirty_Reset();  // Clear dirty after full refresh
}
```

Alternatively, full-screen can call `LCD_DisplayRegion(0, 0, 159, 127)` and then `Dirty_Reset()` for consistency.

---

## 3. Performance

| Scenario | Full refresh | Dirty update (example 40×40) |
|----------|--------------|------------------------------|
| Bytes transferred | 81,920 | ~3,200 |
| Speedup | 1× | ~25× |

The gain scales with how small the dirty region is compared to the full screen.

---

## 4. Usage pattern

```typescript
// Draw something
LCD1IN8.DrawPoint(50, 50, 0xF800, DOT_PIXEL.DOT_PIXEL_2)
LCD1IN8.ShowString(10, 10, "Hello", COLOR.RED)

// Only update changed area
LCD1IN8.LCD_DisplayDirty()
```

For a full redraw (e.g. after a big change), keep calling `LCD_Display()`.

---

## 5. Edge cases

1. **Bounds:** Clamp `Xpoint` / `Ypoint` in `LCD_SetPoint` as above.
2. **Empty dirty rect:** When `isDirty` is false, `LCD_DisplayDirty()` returns immediately.
3. **Dirty region size:** For very small regions, the per-transfer SPI overhead can dominate; the benefit comes when the dirty region is relatively small compared to full screen.

---

## 6. Optional: grid-based dirty regions

If many scattered regions change, a grid of dirty flags can reduce SPI traffic:

- Divide screen into 16×16 tiles (e.g. 10×8 pixels).
- Mark tiles dirty on `LCD_SetPoint`.
- In `LCD_DisplayDirty`, iterate only over dirty tiles.

This adds some bookkeeping but can help when updates are spread across the screen.

---



## License

MIT

## Supported targets

* for PXT/microbit
(The metadata above is needed for package search.)

