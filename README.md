# Tool xuất chi tiết hóa đơn điện tử ra Excel

Đọc file hóa đơn XML (chuẩn TT78) tải từ hoadondientu.gdt.gov.vn và xuất ra Excel đầy đủ chi tiết.
Tool không đăng nhập hay gọi cổng thuế — bạn tự tải file, tool chỉ xử lý file trên máy.

## Tải tự động hàng trăm hóa đơn (khuyên dùng)

1. Bấm đúp `tai-hoa-don.bat` → mở cửa sổ Edge riêng của tool.
2. Trong cửa sổ đó: đăng nhập, vào **Tra cứu → Tra cứu hóa đơn**, chọn tab, khoảng ngày → **Tìm kiếm**.
3. Quay lại cửa sổ đen, nhấn **Enter** → tool lần lượt chọn từng hóa đơn và bấm **Xuất xml**, tự sang trang.
4. Muốn tải tab khác (bán ra / mua vào / máy tính tiền) thì tìm kiếm tab đó rồi nhấn Enter lần nữa.
5. Gõ **q** + Enter để kết thúc → tool tự xuất file Excel vào `output/`.

File tải về được lưu riêng theo loại (tool tự nhận biết theo tab đang mở):

- `input/mua-vao/` — hóa đơn mua vào
- `input/ban-ra/` — hóa đơn bán ra

Tên file: `MSTngườibán_KýhiệuMẫusốKýhiệu_Số.zip`. Hóa đơn đã có sẽ được bỏ qua, nên chạy lại
cùng khoảng ngày chỉ tải thêm hóa đơn mới. Tốc độ khoảng 1–2 giây/hóa đơn.
Đừng thao tác trên cửa sổ trình duyệt trong lúc tool đang tải.

Có file tải tay để lẫn lộn trong `input/`? Chạy `node sap-xep.js` để tự chia vào 2 thư mục trên
(file trùng chuyển vào `input/_trung`, tool không đọc thư mục bắt đầu bằng `_`).

## Bảng kê theo mẫu (`hoadon/bang_ke_mua_ban.xlsx`)

Tự chạy khi kết thúc tải (gõ q), hoặc bấm đúp `xuat-bang-ke.bat`.

**Mỗi tháng 1 file riêng** (theo **ngày lập** hóa đơn), chỉ chứa dữ liệu của tháng đó:

- Sheet tháng (vd `T09`) và `Total`: hóa đơn mua vào của tháng (`input/mua-vao`).
- Sheet `Bán ra`: hóa đơn bán ra của tháng (`input/ban-ra`), giữ công thức cột M, Q, R như mẫu.
- Mỗi dòng hàng hóa là 1 dòng; cuối sheet có dòng TỔNG CỘNG.
- Tên file: `ket_qua/bang_ke_mua_ban_T09-2026_<năm-tháng-ngày>_<giờ>.xlsx`.
- Chạy lại sau khi tải thêm: mở file mới nhất **của tháng đó**, chỉ thêm hóa đơn chưa có
  (so theo ký hiệu + số + MST người bán), lưu thành file mới. Tháng không có hóa đơn mới thì không tạo file.
- Định dạng lấy từ `hoadon/bang_ke_mua_ban.xlsx` nếu có, không thì từ `mau/bang_ke_mau.xlsx`.

## Cách dùng thủ công

1. Đăng nhập cổng thuế → **Tra cứu → Tra cứu hóa đơn** → tab *mua vào* hoặc *bán ra* → Tìm kiếm →
   bấm **Tải về** ở từng hóa đơn (file `.zip` chứa XML).
2. Bỏ các file `.zip` / `.xml` vào thư mục `input/` (để lẫn bán ra / mua vào, chia thư mục con thoải mái).
3. Bấm đúp `start.bat` → trang `http://localhost:3456` tự mở → **Đọc hóa đơn & xuất Excel**.
4. File Excel nằm trong `output/`, mỗi lần chạy 1 file mới.

Tool tự nhận MST doanh nghiệp (MST xuất hiện nhiều nhất); có thể nhập tay. Hóa đơn có người bán = MST
đó là **bán ra**, người mua = MST đó là **mua vào**. Hóa đơn tải trùng tự bỏ qua.

## Nội dung Excel (cho mỗi nhóm Bán ra / Mua vào)

| Sheet | Nội dung |
|---|---|
| `Danh sach` | Mỗi hóa đơn 1 dòng: ký hiệu, số, ngày lập, ngày ký, mã CQT, người bán / người mua (MST, tên, địa chỉ, SĐT, email, STK, ngân hàng), HTTT, tiền tệ, tổng tiền chưa thuế / thuế / chiết khấu / phí / thanh toán, bằng chữ, thông tin khác, tên file |
| `Chi tiet hang hoa` | Mỗi dòng hàng 1 dòng: tính chất, mã hàng, tên, ĐVT, số lượng, đơn giá, chiết khấu, thành tiền, thuế suất |
| `Theo thue suat` | Tiền hàng / tiền thuế theo từng mức thuế suất của mỗi hóa đơn |
| `Loi doc file` | File không đọc được (nếu có) |
