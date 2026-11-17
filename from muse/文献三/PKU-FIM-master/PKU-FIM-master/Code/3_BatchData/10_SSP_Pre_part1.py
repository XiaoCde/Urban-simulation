# -*-coding:utf-8 -*-
# python 3.9
# 提取SSP 获取1901-2023的最大降水

"""
# @File       : 10_SSP_Pre_part1.py
# @software   : PyCharm  
# @Time       ：2025/5/20 21:53
# @Author     ：Wei Lyu
"""

import xarray as xr
import numpy as np


if __name__ == '__main__':
    path = r'D:\LW\ABM\Data\Pre'

    prefix = 'pre_'

    for i in range(1950, 2024):
        ds = xr.open_dataset(path + '\\' + prefix + str(i) + '\\' + prefix + str(i) + '.nc')
        a = np.nanmax(ds.pre.values, axis=0)
        if i == 1950:
            final = a
            continue
        final = np.fmax(final, a)
        print(i)

    # 将其包装成 DataArray，并复制原始空间坐标
    da = xr.DataArray(
        final,
        coords={"lat": ds["lat"], "lon": ds["lon"]},
        dims=["lat", "lon"],
        name="years_max_1950_2023"
    )

    # 复制投影信息（确保原数据带有 CRS 信息）
    da.rio.write_crs(ds.rio.crs or "EPSG:4326", inplace=True)  # 或直接设置 EPSG 编码

    # 设置空间维度
    da = da.rio.set_spatial_dims(x_dim="lon", y_dim="lat")

    # 保存为 GeoTIFF
    da.rio.to_raster(r'D:\LW\ABM\Data\Pre\years_max_1950_2023.tif', compress='deflate')  # 支持压缩