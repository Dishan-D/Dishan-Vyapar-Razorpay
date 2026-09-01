# Photos that extract cleanly

Measured against this project's own OCR, not guessed. Every number below came
from running `readPhoto()` over real images.

| image | OCR confidence | prices found |
|---|---|---|
| Rendered price list, black on white, sans-serif | **93–94** | all of them |
| Supplier flyer, same treatment | **93** | all four |
| Plain photograph of folded cloth | **22–36** | none — and the "text" was noise |

The gate in `src/structuring/ocr.ts` rejects anything under 45 confidence, so a
photo with no printed text contributes nothing rather than contributing
nonsense. That is deliberate: a photo of a saree is still read by the vision
model, it just gets no OCR assist.

---

## Prompt for Gemini (or any image generator)

Paste this, replacing the shop name and the product lines.

```
Create a clean, flat product price list image for an Indian shop.

STRICT FORMATTING RULES — these matter more than aesthetics:
- Pure white background. No texture, no gradient, no watermark, no background photo.
- Pure black text. Nothing grey, nothing coloured, no drop shadows, no outlines.
- A plain sans-serif font (Helvetica or Arial style). No script, no handwriting,
  no decorative or condensed faces.
- All text perfectly horizontal. Nothing rotated, curved, skewed or arched.
- Large type: product names at least 34px, prices at least 30px.
- Left-aligned. Generous spacing between lines. Nothing overlapping.
- No product photographs, no icons, no logos, no borders around text.

CONTENT — one block per product, in exactly this layout:

    <Shop name>
    Contact: <phone>  |  <upi id>
    ------------------------------------------
    <Product name>
    Rs. <price>/-     Stock: <count>

    <Product name>
    Rs. <price>/-     Stock: <count>

Use these products:
    Zenbook Pro 14 Laptop — Rs. 62,999/- — Stock: 4
    Smartview 43 inch LED TV — Rs. 24,500/- — Stock: 7
    Techno Buds Wireless Earbuds — Rs. 1,899/- — Stock: 25
    Homechef 20L Microwave Oven — Rs. 8,750/- — Stock: 6

Portrait orientation, roughly 900x1100 pixels.
```

## Price formats the parser accepts

`amountsIn()` in `src/structuring/ocr.ts` is deliberately narrow, because a shop
photo is full of digits that are not prices — dates, phone numbers, GST numbers,
weights. A number is only taken as money when it is marked as money:

| written as | read |
|---|---|
| `Rs. 62,999/-` | ✅ 62999 |
| `₹1,899` | ✅ 1899 |
| `MRP: 450` | ✅ 450 |
| `INR 8750` | ✅ 8750 |
| `1299/-` | ✅ 1299 |
| `1299 rupees` | ✅ 1299 |
| `62999` on its own | ❌ ignored |
| `98450 11223` (phone) | ❌ ignored |
| `20260812` (date) | ❌ ignored |

Anything under ₹5 or over ₹5,00,000 is dropped as well — below that is a stray
digit, above it is not stock in the shops this is built for.

**`Rs. <price>/-` is the safest form.** Use it.

## Whose brand is on the flyer does not matter

A flyer headed with a distributor's name, or packaging carrying a
manufacturer's brand, is normal — a shop selling Samsung televisions has
Samsung on the box. The prompts state this explicitly, after an early version
read a supplier flyer perfectly and then refused to list anything from it
because the letterhead did not match the shop's name.

## If you are photographing something real

- Fill the frame with the price list or the packaging label.
- Straight on, not at an angle.
- Even light. A flash reflection off plastic wrap removes the text entirely.
- One product per photo where you can. A shelf photo gets read, but nothing
  reliably ties a product in it to its price.

For the five products you actually care about, use **One by one** on the
onboarding screen instead. Typing the name and attaching its photo skips
extraction altogether, and what you type is exactly what an AI buyer sees.
