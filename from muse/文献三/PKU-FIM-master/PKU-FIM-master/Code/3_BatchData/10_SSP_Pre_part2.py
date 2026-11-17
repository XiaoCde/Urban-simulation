# -*-coding:utf-8 -*-
# python 3.9
# 提取SSP 获取2024-2050的最大降水

"""
# @File       : 10_SSP_Pre_part2.py
# @software   : PyCharm  
# @Time       ：2025/5/19 15:11
# @Author     ：Wei Lyu
"""

import xarray as xr
import numpy as np

if __name__ == '__main__':
    path = r'D:\LW\ABM\Data\Pre_SSP'

    prefix = 'EC-Earth3_ssp585_pre-30s-'

    for i in range(2, 15+1):
        ds = xr.open_dataset(
            path + '\\' + prefix + str(i) + '\\' + prefix + str(i) + '.nc')
        a = np.nanmax(ds.pre.values, axis=0)
        if i == 2:
            final = a
            continue
        final = np.fmax(final, a)

    # 将其打包成 DataArray，并复制原始空间坐标
    da = xr.DataArray(
        final,
        coords={"lat": ds["lat"], "lon": ds["lon"]},
        dims=["lat", "lon"],
        name="years_max_2024_2050"
    )

    # 复制投影信息（确保原数据带有 CRS 信息）
    da.rio.write_crs(ds.rio.crs or "EPSG:4326", inplace=True)  # 或直接设置 EPSG 编码

    # 设置空间维度
    da = da.rio.set_spatial_dims(x_dim="lon", y_dim="lat")

    # 保存为 GeoTIFF
    da.rio.to_raster(r'D:\LW\ABM\Data\Pre_SSP\years_max_2024_2050.tif', compress='deflate')  # 支持压缩




    # ----------------------------------------- 两个part取最大值，然后存储
    # import cv2
    # import xarray as xr
    # import numpy as np
    # da1 = cv2.imread(r'D:\LW\ABM\Data\Pre\years_max_1950_2023.tif', cv2.IMREAD_UNCHANGED)
    # da2 = cv2.imread(r'D:\LW\ABM\Data\Pre_SSP\years_maxClip.tif', cv2.IMREAD_UNCHANGED)
    #
    # da3 = np.fmax(da1, da2)
    #
    # ds = xr.open_dataset(r'D:\LW\ABM\Data\Pre' + '\\' + 'pre_' + str(1950) + '\\' + 'pre_' + str(1950) + '.nc')
    #
    # da = xr.DataArray(
    #     da3/30, # 日均
    #     coords={"lat": ds["lat"], "lon": ds["lon"]},
    #     dims=["lat", "lon"],
    #     name="years_mean_1950_2050"
    # )
    #
    # # 复制投影信息（确保原数据带有 CRS 信息）
    # da.rio.write_crs(ds.rio.crs or "EPSG:4326", inplace=True)  # 或直接设置 EPSG 编码
    # # 设置空间维度
    # da = da.rio.set_spatial_dims(x_dim="lon", y_dim="lat")
    # # 保存为 GeoTIFF
    # da.rio.to_raster(r'D:\LW\ABM\OutputData\Pre_SSP\years_mean_1950_2050.tif', compress='deflate')  # 支持压缩






