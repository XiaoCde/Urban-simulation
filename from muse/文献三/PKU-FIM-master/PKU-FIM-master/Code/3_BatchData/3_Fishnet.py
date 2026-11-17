# -*-coding:utf-8 -*-
# python 2.7
# 批量创建fishnet

"""
# @File       : 3_Fishnet.py
# @software   : PyCharm  
# @Time       ：2024/6/11 20:13
# @Author     ：Wei Lyu
"""

import arcpy
import os
import pandas as pd
import sys
import math
reload(sys)
sys.setdefaultencoding('utf-8')



def create_fishnet(out_feature_class, origin_coord, y_axis_coord, cell_width, cell_height, num_rows, num_columns, opposite_corner, labels="NO_LABELS", template_extent="#", geometry_type="POLYGON"):
    arcpy.CreateFishnet_management(out_feature_class, origin_coord, y_axis_coord, cell_width, cell_height, num_rows, num_columns, opposite_corner, labels, template_extent, geometry_type)
    spatial_ref = arcpy.SpatialReference(4326)
    arcpy.DefineProjection_management(out_feature_class, spatial_ref)

if __name__ == '__main__':

    path = 'D:/LW/ABM/Data'

    arcpy.env.workspace = 'D:/LW/ABM/OutputData/cities_21.gdb'
    arcpy.env.overwriteOutput = True

    # 输入属性表路径
    table = "cities_21"

    # 要读取的列名
    field_name = 'name'

    # 创建一个空集合来存储唯一值
    city_names = set()

    # 使用arcpy.SearchCursor遍历表格
    with arcpy.da.SearchCursor(table, [field_name]) as cursor:
        for row in cursor:
            city_names.add(row[0])

    dir_path = 'D:/LW/ABM/OutputData/cities_21'

    # np.save(dir_path + '/' + 'citiesList.npy', list(city_names))

    for name in city_names:
        # 拼接完整路径
        folder_path = os.path.join(dir_path, name)

        # 检查文件夹是否存在，如果不存在则创建
        if not os.path.exists(folder_path):
            os.mkdir(folder_path)
            print("Created folder:", folder_path)
        else:
            print("Folder already exists:", folder_path)

    # 制作city.shp
    input_feature_class = 'cities_92'
    for name in city_names:
        # name = '安阳市'
        output_feature_class = dir_path + '/' + name + '/' + name + '.shp'
        sql_query = "name = " + '\'' + str(name) + '\''
        arcpy.MakeFeatureLayer_management(input_feature_class, "temp_layer")
        arcpy.SelectLayerByAttribute_management("temp_layer", "NEW_SELECTION", sql_query)
        arcpy.CopyFeatures_management("temp_layer", output_feature_class)
        arcpy.Delete_management("temp_layer")
        print(name)

    # 制作city_bbox.shp
    grid_size = 0.008 
    for name in city_names:
        input_feature_class = dir_path + '/' + name + '/' + name + '.shp'
        output_grid = dir_path + '/' + name + '/' + name + '_bbox.shp'

        extent = arcpy.Describe(input_feature_class).extent
        origin_coord = "{} {}".format(extent.XMin, extent.YMin)
        y_axis_coord = "{} {}".format(extent.XMin, extent.YMin + 0.008)  # 任意的 y 轴参考点，增加X度
        opposite_corner = "{} {}".format(extent.XMax, extent.YMax)

        create_fishnet(output_grid, origin_coord, y_axis_coord, grid_size, grid_size, 0, 0, opposite_corner)
        print(name)

    # 给city_bbox新增一列tmpTid，和FID相等
    for name in city_names:
        fc = dir_path + '/' + name + '/' + name + '_bbox.shp'
        arcpy.AddField_management(fc, "Tid", "LONG")
        rows = arcpy.da.UpdateCursor(fc, ['FID', "Id", 'Tid'])
        for r in rows:
            r[1] = r[0]
            r[2] = r[0]
            rows.updateRow(r)
        del rows

    # 制作city_grid.shp
    for name in city_names:
        input_feature_class = dir_path + '/' + name + '/' + name + '_bbox.shp'
        reference_feature_class = dir_path + '/' + name + '/' + name + '.shp'
        output_feature_class = dir_path + '/' + name + '/' + name + '_grid.shp'
        arcpy.MakeFeatureLayer_management(input_feature_class, "input_layer")
        arcpy.MakeFeatureLayer_management(reference_feature_class, "reference_layer")
        arcpy.SelectLayerByLocation_management("input_layer", "INTERSECT", "reference_layer")
        arcpy.CopyFeatures_management("input_layer", output_feature_class)
        arcpy.Delete_management("input_layer")
        arcpy.Delete_management("reference_layer")
        arcpy.DeleteField_management(input_feature_class, ["Tid"])
        print(name)

    # for name in city_names:
    #     output_feature_class = dir_path + '/' + name + '/' + name + '_grid.shp'
    #     arcpy.DeleteField_management(output_feature_class, ["tmpTid"])



    # # 制作city_county.shp
    # input_feature_class = 'cities_92_county'
    # for name in city_names:
    #     reference_feature_class = dir_path + '/' + name + '/' + name + '.shp'
    #     output_feature_class = dir_path + '/' + name + '/' + name + '_county.shp'
    #     arcpy.MakeFeatureLayer_management(input_feature_class, "input_layer")
    #     arcpy.MakeFeatureLayer_management(reference_feature_class, "reference_layer")
    #     arcpy.SelectLayerByLocation_management("input_layer", "WITHIN", "reference_layer")
    #     arcpy.CopyFeatures_management("input_layer", output_feature_class)
    #     arcpy.Delete_management("input_layer")
    #     arcpy.Delete_management("reference_layer")
    #     print(name)
    #
    # # 空间连接
    # for name in city_names:
    #     target_features = dir_path + '/' + name + '/' + name + '_bbox.shp'
    #     join_features = dir_path + '/' + name + '/' + name + '_county.shp'
    #     out_feature_class = dir_path + '/' + name + '/' + name + '_bbox_sj.shp'
    #     arcpy.SpatialJoin_analysis(target_features, join_features, out_feature_class)
    #     print(name)
    #     # break
    #
    # # 给属性表添加字段，countyID
    # for name in city_names:
    #     county_names = set()
    #     fc = dir_path + '/' + name + '/' + name + '_bbox_sj.shp'
    #     with arcpy.da.SearchCursor(fc, ["name"]) as cursor:
    #         for row in cursor:
    #             county_names.add(row[0])
    #     county_names = sorted(county_names)
    #     arcpy.AddField_management(fc, "county_id", "SHORT")
    #     with arcpy.da.UpdateCursor(fc, ["name", "county_id"]) as cursor:
    #         for r in cursor:
    #             r[1] = county_names.index(r[0])
    #             cursor.updateRow(r)
    #     output_csv = dir_path + '/' + name + '/' + name + '_bbox_countyID.csv'
    #     with open(output_csv, 'wb') as csvfile:
    #         writer = csv.writer(csvfile)
    #         writer.writerow(['FID', 'county_id'])  # 写入字段名作为首行
    #         with arcpy.da.SearchCursor(fc, ['FID', 'county_id']) as cursor:
    #             for row in cursor:
    #                 writer.writerow([row[0]+1, row[1]])
    #     print(name)
    #     # break
    #
    # # 把countyID的文件都放到all_cities_countyID文件夹里
    # for name in city_names:
    #     source_file = dir_path + '/' + name + '/' + name + '_bbox_countyID.csv'
    #     destination_folder = dir_path + '/' + "all_cities_countyID"
    #     destination_file = os.path.join(destination_folder, os.path.basename(source_file))
    #     shutil.copy2(source_file, destination_file)
    #
    # # 删除每个文件夹里面的sj文件
    # for name in city_names:
    #     fc = dir_path + '/' + name + '/' + name + '_bbox_sj.shp'
    #     arcpy.Delete_management(fc)
    #     print(name)
        # break

    # 计算每个grid的行列数
    grid_size = 0.008
    df = pd.DataFrame(0, index=range(len(city_names)), columns=['city_name', 'rows', 'cols'])
    k = 0
    for name in city_names:
        fc = dir_path + '/' + name + '/' + name + '_bbox.shp'
        extent = arcpy.Describe(fc).extent
        num_columns = math.ceil((extent.XMax - extent.XMin) / grid_size)
        num_rows = math.ceil((extent.YMax - extent.YMin) / grid_size)
        df.iloc[k, :] = [name, num_rows, num_columns]
        k += 1
    df['rows'] = df['rows'].astype(int)
    df['cols'] = df['cols'].astype(int)
    df.to_csv(dir_path + '/cities_row_col.csv', index=0, header=1)  # 这里的行列数可能稍微有点误差，后期要手动调整
